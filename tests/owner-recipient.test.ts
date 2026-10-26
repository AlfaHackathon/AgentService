import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { projectJobResult } from '../src/news-analysis/application/job-projection.ts';
import { NewsFlow } from '../src/news-analysis/application/news-flow.ts';
import { analysisReceiptSchema, materialSchema } from '../src/news-analysis/contracts/analysis.ts';
import type {
  DeclaredCompanyContext,
  DeclaredRecipientContext,
} from '../src/news-analysis/contracts/declared-context.ts';
import {
  companyBankDataSchema,
  declaredContextUsage,
  declaredRecipientUsage,
} from '../src/news-analysis/contracts/declared-context.ts';
import { NewsAnalysisError } from '../src/news-analysis/contracts/errors.ts';
import { jobProjectionSchema } from '../src/news-analysis/contracts/execution.ts';
import {
  checkpointSchema,
  type FlowReasoner,
  flowRequestSchema,
  jobSchema,
} from '../src/news-analysis/contracts/flow.ts';
import { CompanyClient } from '../src/news-analysis/retrieval/company-client.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { FlowContextClient, FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const financier = '22222222-2222-4222-8222-222222222222';
const director = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const directorAccountId = '55555555-5555-4555-8555-555555555555';
const asOf = '2026-10-26T12:00:00Z';
function company(): DeclaredCompanyContext {
  return { companyId, asOf, bankProfile: null, paymentActivity: null, usage: declaredContextUsage };
}

function recipient(role: string | null, mappedUserId = accountId): DeclaredRecipientContext {
  const source = {
    userId: mappedUserId,
    companyId,
    revisionId: 'source-1',
    knownAt: asOf,
    contentHash: 'a'.repeat(64),
    sourceOwner: 'user-service' as const,
    serviceGeography: { cityName: '  Москва ', rcName: null },
    provenance: {
      sourceId: 'synthetic-source-account',
      versionId: 'v1',
      contentHash: 'b'.repeat(64),
    },
  };
  return {
    companyId,
    asOf,
    sourceAccount: source,
    viewer:
      role === null
        ? null
        : {
            ...source,
            revisionId: 'viewer-1',
            role: { id: financier, name: role, isDefault: false },
          },
    usage: declaredRecipientUsage,
  };
}

function prepared(personIds = [financier, director]) {
  const receipt = analysisReceiptSchema.parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/insight-receipt-null-ast.json', import.meta.url), 'utf8'),
    ),
  );
  const effect = receipt.effects[0];
  if (!effect) throw new Error('Missing synthetic canonical effect');
  return jobProjectionSchema.parse({
    canonicalCompanies: [{ companyId, status: 'completed', receipt }],
    roleViews: [],
    result: {},
    roleScopes: personIds.map((personId, index) => ({
      key: `role-${index}`,
      scopeVersion: `opaque-${index}`,
      profile: {
        personId,
        companyId,
        role: 'Knowledge role',
        responsibilities: ['Existing scope'],
      },
      facts: [
        {
          companyId,
          effectId: effect.effectId,
          revision: effect.currentRevision,
          priority: 1,
          requiresReassessment: false,
        },
      ],
      groups: [
        {
          groupId: 'synthetic-group',
          companyIds: [companyId],
          complete: false,
          coverage: {
            expectedCompanies: 1,
            analyzedCompanies: 1,
            missingCompanyIds: [],
            missingGroups: [],
            cycles: [],
            unknownEffects: [effect.effectId],
            duplicateObjects: [],
            unrevisedEffectIds: [],
            emptyCompanyIds: [],
            partialContextCompanyIds: [companyId],
            aggregationRuleConfirmed: false,
          },
          totals: [
            {
              metric: 'expense_delta',
              amountBasis: 'contract_total',
              unit: 'RUB',
              period: '2026',
              question: null,
              knownSubtotal: '10000.125',
              fullTotal: null,
              coverage: {
                complete: false,
                missingCompanyIds: [],
                unresolvedEffectIds: [effect.effectId],
                duplicateObjects: [],
              },
              effectIds: [effect.effectId],
              companyIds: [companyId],
            },
          ],
          sourceRefs: [],
        },
      ],
    })),
  });
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function owners() {
  return {
    company: vi.fn(async (_companyId: string, _asOf: string) => company()),
    recipient: vi.fn(
      async (
        personId: string,
        _companyId: string,
        _asOf: string,
      ): Promise<DeclaredRecipientContext | null> =>
        personId === financier
          ? recipient('Финансист')
          : recipient('Ген директор', directorAccountId),
    ),
  };
}

async function project(data: ReturnType<typeof prepared>, owner?: ReturnType<typeof owners>) {
  const jobs = new FlowJobClient('http://insights.test', 'synthetic-secret');
  const projection = vi
    .spyOn(jobs, 'projection')
    .mockResolvedValueOnce(data)
    .mockImplementationOnce(async (_id, _segments, roleViews) => ({
      ...data,
      roleScopes: [],
      roleViews: roleViews ?? [],
    }));
  const checkpoint = checkpointSchema.parse({});
  const role = vi.fn<FlowReasoner['role']>(async (profile, facts) => ({
    actions: [
      {
        action: profile.role,
        rationale: 'Framing only',
        effectIds: facts.map((fact) => fact.effectId),
        priority: 1,
      },
    ],
    missingContext: [],
  }));
  await projectJobResult({
    jobId: 'synthetic-job',
    jobs,
    checkpoint,
    asOf,
    reasoner: { plan: vi.fn(), role },
    save: async () => {},
    ensureLease: () => {},
    ...(owner ? { owners: owner } : {}),
  });
  return { checkpoint, role, projection };
}

it('frames financier/director actions from mapped viewer roles without changing authoritative facts, groups or scope versions', async () => {
  const data = freeze(prepared());
  const before = JSON.stringify(data);
  const owner = owners();
  const result = await project(data, owner);
  expect(result.role.mock.calls.map(([profile]) => profile.role)).toEqual([
    'Финансист',
    'Ген директор',
  ]);
  expect(owner.recipient.mock.calls).toEqual([
    [financier, companyId, asOf],
    [director, companyId, asOf],
  ]);
  expect(owner.company).toHaveBeenCalledExactlyOnceWith(companyId, asOf);
  for (const [index, [profile, facts, groups]] of result.role.mock.calls.entries()) {
    const scope = data.roleScopes[index];
    expect(profile).not.toBe(scope?.profile);
    expect(profile).toMatchObject({
      responsibilities: ['Existing scope'],
      recipientContext: {
        company: company(),
        knowledgeRole: 'Knowledge role',
        usage: 'framing/actions only; no ACL/arithmetic',
      },
    });
    expect(facts).toBe(scope?.facts);
    expect(groups).toBe(scope?.groups);
    expect(groups?.[0]?.totals[0]).toMatchObject({ knownSubtotal: '10000.125', fullTotal: null });
  }
  expect(result.projection.mock.calls[1]?.[2]).toMatchObject([
    { key: 'role-0', scopeVersion: 'opaque-0', actions: [{ action: 'Финансист' }] },
    { key: 'role-1', scopeVersion: 'opaque-1', actions: [{ action: 'Ген директор' }] },
  ]);
  expect(JSON.stringify(data)).toBe(before);
  expect(JSON.stringify(result.checkpoint.canonicalCompanies)).toBe(
    JSON.stringify(data.canonicalCompanies),
  );
  await project(data, owner);
  expect(owner.company).toHaveBeenCalledTimes(2); // Cache lifetime is exactly one projection.
});

it.each(['no-config', 'non-uuid', 'missing-pair'])(
  'retains the existing authoritative role when owner context is unavailable: %s',
  async (mode) => {
    const data = prepared(mode === 'non-uuid' ? ['legacy-person'] : [financier]);
    const owner = owners();
    if (mode === 'missing-pair') owner.recipient.mockResolvedValue(null);
    const result = await project(data, mode === 'no-config' ? undefined : owner);
    expect(result.role.mock.calls[0]?.[0]).toBe(data.roleScopes[0]?.profile);
    expect(result.role.mock.calls[0]?.[0]).not.toHaveProperty('recipientContext');
    expect(owner.company).not.toHaveBeenCalled();
    expect(owner.recipient).toHaveBeenCalledTimes(mode === 'missing-pair' ? 1 : 0);
  },
);

it('retains mapped source geography with viewer404 and preserves the knowledge role and all unknowns', async () => {
  const owner = owners();
  owner.recipient.mockResolvedValue(recipient(null));
  const data = freeze(prepared([financier]));
  const result = await project(data, owner);
  expect(result.role.mock.calls[0]?.[0]).toMatchObject({
    role: 'Knowledge role',
    recipientContext: {
      recipient: {
        viewer: null,
        sourceAccount: { serviceGeography: { cityName: '  Москва ', rcName: null } },
      },
    },
  });
  expect(result.role.mock.calls[0]?.[2]?.[0]?.totals[0]?.fullTotal).toBeNull();
});

it('preserves an explicitly unassigned viewer role without inventing a director or replacing the knowledge role', async () => {
  const owner = owners();
  const mapped = recipient(null);
  owner.recipient.mockResolvedValue({ ...mapped, viewer: { ...mapped.sourceAccount, role: null } });
  const result = await project(freeze(prepared([financier])), owner);
  expect(result.role.mock.calls[0]?.[0]).toMatchObject({
    role: 'Knowledge role',
    recipientContext: { knowledgeRole: 'Knowledge role', recipient: { viewer: { role: null } } },
  });
});

it('fails only a denied recipient role view instead of silently reasoning with the old role', async () => {
  const owner = owners();
  owner.recipient.mockRejectedValueOnce(
    new NewsAnalysisError(403, 'OWNER_SCOPE_DENIED', 'Synthetic denial'),
  );
  const data = freeze(prepared());
  const before = JSON.stringify(data);
  const result = await project(data, owner);
  expect(result.role).toHaveBeenCalledTimes(1);
  expect(result.projection.mock.calls[1]?.[2]).toMatchObject([
    { key: 'role-0', scopeVersion: 'opaque-0', error: 'OWNER_SCOPE_DENIED' },
    { key: 'role-1', scopeVersion: 'opaque-1', status: 'proposed' },
  ]);
  expect(JSON.stringify(data)).toBe(before);
});

it('fails role views on company context502 while preserving canonical receipts and sharing only the failing local read', async () => {
  const owner = owners();
  owner.company.mockRejectedValue(
    new NewsAnalysisError(502, 'OWNER_CONTEXT_INVALID', 'Synthetic owner contract failure'),
  );
  const data = freeze(prepared());
  const before = JSON.stringify(data.canonicalCompanies);
  const result = await project(data, owner);
  expect(result.role).not.toHaveBeenCalled();
  expect(owner.company).toHaveBeenCalledTimes(1);
  expect(result.projection.mock.calls[1]?.[2]).toEqual([
    { key: 'role-0', scopeVersion: 'opaque-0', error: 'OWNER_CONTEXT_INVALID' },
    { key: 'role-1', scopeVersion: 'opaque-1', error: 'OWNER_CONTEXT_INVALID' },
  ]);
  expect(JSON.stringify(result.checkpoint.canonicalCompanies)).toBe(before);
});

it('rejects combined recipient framing over48k when each owner block fits without truncating context or canonical facts', async () => {
  const owner = owners();
  const bankData = companyBankDataSchema.parse(
    Object.fromEntries(companyBankDataSchema.keyof().options.map((key) => [key, null])),
  );
  const largeCompany: DeclaredCompanyContext = {
    ...company(),
    bankProfile: {
      companyId,
      revisionId: 'bank-1',
      knownAt: asOf,
      bankData: { ...bankData, mainOkvedName: 'c'.repeat(26000) },
      sourceId: 'company-bank-profile',
      sourceRefs: [{ materialId: 'synthetic-bank', versionId: 'v1', contentHash: 'c'.repeat(64) }],
      provenance: {
        acquisition: 'event_payload',
        sourceUrl: null,
        retrievedAt: asOf,
        textCompleteness: 'full',
        originVersionId: null,
        locator: null,
      },
    },
  };
  const mapped = recipient(null);
  const largeRecipient: DeclaredRecipientContext = {
    ...mapped,
    sourceAccount: {
      ...mapped.sourceAccount,
      serviceGeography: { cityName: 'r'.repeat(12000), rcName: 'r'.repeat(12000) },
    },
  };
  expect(JSON.stringify(largeCompany).length).toBeLessThan(48000);
  expect(JSON.stringify(largeRecipient).length).toBeLessThan(48000);
  const beforeContext = JSON.stringify({ largeCompany, largeRecipient });
  owner.company.mockResolvedValue(largeCompany);
  owner.recipient.mockResolvedValue(largeRecipient);
  const data = freeze(prepared([financier]));
  const beforeCanonical = JSON.stringify(data);
  const result = await project(data, owner);
  expect(result.role).not.toHaveBeenCalled();
  expect(result.projection.mock.calls[1]?.[2]).toEqual([
    { key: 'role-0', scopeVersion: 'opaque-0', error: 'DECLARED_CONTEXT_BUDGET' },
  ]);
  expect(JSON.stringify(data)).toBe(beforeCanonical);
  expect(JSON.stringify({ largeCompany, largeRecipient })).toBe(beforeContext);
});

it('forwards optional owner loaders through NewsFlow projection without passing viewer roles into the company analyzer', async () => {
  const data = prepared();
  const parameters = flowRequestSchema.parse({
    newsMaterialId: 'synthetic-news',
    newsVersionId: 'v1',
    asOf,
    projectionOnly: true,
  });
  let job = jobSchema.parse({
    request: {
      jobId: 'flow-owner',
      newsMaterialId: parameters.newsMaterialId,
      newsVersionId: parameters.newsVersionId,
      asOf,
      parameters,
    },
    status: 'running',
    version: 1,
    workerId: 'worker',
    leaseUntil: asOf,
    error: null,
    updatedAt: asOf,
    checkpoint: {
      plan: { eventSummary: 'Canonical', queries: ['canonical'], generalInsights: [] },
      selectedCompanyIds: [companyId],
      companies: data.canonicalCompanies,
    },
  });
  const context = new FlowContextClient('http://context.test', 'synthetic-secret');
  vi.spyOn(context, 'news').mockResolvedValue(
    materialSchema.parse({
      materialId: parameters.newsMaterialId,
      versionId: parameters.newsVersionId,
      sourceId: 'synthetic-news',
      kind: 'news',
      title: 'Synthetic',
      text: 'Synthetic',
      knownAt: asOf,
      contentHash: 'a'.repeat(64),
      companyIds: [],
      bankProfileIds: [],
    }),
  );
  vi.spyOn(context, 'sync').mockResolvedValue(undefined);
  const jobs = new FlowJobClient('http://insights.test', 'synthetic-secret');
  vi.spyOn(jobs, 'claim').mockResolvedValue(job);
  vi.spyOn(jobs, 'update').mockImplementation(async (_previous, checkpoint, status) => {
    job = {
      ...job,
      checkpoint: structuredClone(checkpoint),
      status: status ?? 'running',
      version: job.version + 1,
    };
    return job;
  });
  vi.spyOn(jobs, 'projection')
    .mockResolvedValueOnce(data)
    .mockImplementationOnce(async (_id, _segments, roleViews) => ({
      ...data,
      roleScopes: [],
      roleViews: roleViews ?? [],
    }));
  const analyze = vi.fn();
  const analyzer = new NewsAnalyzer({
    context: new ContextClient('http://context.test', 'synthetic-secret'),
    insights: new InsightClient('http://insights.test', 'synthetic-secret'),
    reasoner: { analyze },
  });
  const owner = owners();
  const role = vi.fn<FlowReasoner['role']>(async () => ({ actions: [], missingContext: [] }));
  await new NewsFlow({
    context,
    jobs,
    analyzer,
    companies: new CompanyClient('http://company.test', 'synthetic-secret'),
    reasoner: { plan: vi.fn(), role },
    owners: owner,
  }).tick();
  expect(role.mock.calls.map(([profile]) => profile.role)).toEqual(['Финансист', 'Ген директор']);
  expect(analyze).not.toHaveBeenCalled();
  expect(job.status).toBe('completed');
  expect(flowRequestSchema.safeParse({ ...parameters, userId: accountId }).success).toBe(false);
});
