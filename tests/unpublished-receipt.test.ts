import { expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { runCompany } from '../src/news-analysis/application/company-run.ts';
import { NewsFlow } from '../src/news-analysis/application/news-flow.ts';
import { analysisReceiptSchema, materialSchema } from '../src/news-analysis/contracts/analysis.ts';
import { jobProjectionSchema } from '../src/news-analysis/contracts/execution.ts';
import {
  checkpointSchema,
  flowRequestSchema,
  jobSchema,
  type NewsJob,
} from '../src/news-analysis/contracts/flow.ts';
import { CompanyClient } from '../src/news-analysis/retrieval/company-client.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { FlowContextClient, FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const time = '2026-10-26T08:00:00Z';
const sourceRef = { materialId: 'news', versionId: 'v1', contentHash: 'a'.repeat(64) };
const request = { companyId, newsMaterialId: 'news', newsVersionId: 'v1', asOf: time };
const unknown = {
  effectKey: 'diagnostic',
  literalObjectRef: `company:${companyId}`,
  expectedPreviousRevisionId: null,
  conclusion: 'Экспозиция не установлена; требуется собственный договор.',
  status: 'unknown',
  sourceRefs: [sourceRef],
  calculation: null,
  impact: {
    metric: 'risk',
    amountBasis: 'qualitative',
    economicObjectId: null,
    evidenceStatus: 'unknown',
    importance: 0,
    urgency: 1,
    novelty: 1,
  },
  assessment: {
    conditions: [],
    unknowns: [
      {
        id: 'missing',
        fact: 'Нужен собственный договор для проверки экспозиции.',
        query: null,
        scope: 'company',
        materialId: null,
      },
    ],
  },
};
const receipt = {
  analysisId: 'no-insight-analysis',
  companyId,
  newsMaterialId: 'news',
  newsVersionId: 'v1',
  asOf: time,
  completedAt: time,
  duplicate: false,
  resultSemantics: 'saved_analysis_revisions_not_latest_heads',
  effects: [],
  outcome: 'no_insight',
  unpublishedDrafts: [unknown],
  contextComplete: false,
};

it('retains unpublished missing-fact diagnostics without inventing a saved effect or outcome for legacy receipts', () => {
  const parsed = analysisReceiptSchema.parse(receipt);
  expect(parsed).toMatchObject({
    outcome: 'no_insight',
    effects: [],
    unpublishedDrafts: [
      { conclusion: unknown.conclusion, status: 'unknown', assessment: unknown.assessment },
    ],
  });
  const { unpublishedDrafts: _drafts, outcome: _outcome, ...legacy } = receipt;
  expect(analysisReceiptSchema.parse(legacy)).not.toHaveProperty('outcome');
  expect(analysisReceiptSchema.parse(legacy)).not.toHaveProperty('unpublishedDrafts');
});

it('completes the company checkpoint for an empty-effects no-insight receipt instead of treating it as a failed job', async () => {
  const news = materialSchema.parse({
    ...sourceRef,
    sourceId: 'synthetic-only',
    kind: 'news',
    title: 'Synthetic',
    text: 'Synthetic news.',
    knownAt: time,
    companyIds: [],
    bankProfileIds: [],
  });
  const calls: string[] = [];
  const backend: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith('/execution/company-plan'))
      return Response.json({
        analysisInput: request,
        relevancePlan: {
          eventSummary: 'Synthetic',
          queries: ['unknown exposure'],
          generalInsights: [],
        },
        requiresWatchRegistration: false,
        watchAfterSequence: 0,
        relevanceSources: [],
        segmentKeys: [],
        receipt,
        depth: {
          policyVersion: 'evidence-depth-v1',
          level: 'canonical_projection',
          reason: 'projection_refresh',
          ownOriginalCount: 0,
          inventoryCompleteForLoadedScope: true,
          sourceRefs: [],
          generalInsightIndexes: [],
          applicability: 'unknown',
          missingFacts: [],
        },
      });
    if (path.endsWith('/execution/company-watch'))
      return Response.json({ requests: [], afterSequence: 0, complete: true });
    throw new Error(`Unexpected fake API ${path}`);
  };
  const jobs = new FlowJobClient('http://insight.test', 'fixture-only', backend);
  const analyzer = new NewsAnalyzer({
    context: new ContextClient('http://context.test', 'fixture-only', backend),
    insights: new InsightClient('http://insight.test', 'fixture-only', backend),
    reasoner: { analyze: vi.fn() },
  });
  const analyze = vi.spyOn(analyzer, 'analyze');
  const checkpoint = checkpointSchema.parse({});
  await runCompany({
    jobId: 'job',
    news,
    companyId,
    jobs,
    analyzer,
    checkpoint,
    reasoner: { plan: vi.fn(), role: vi.fn() },
    save: async () => {},
    enqueue: async () => {
      throw new Error('No follow-up expected');
    },
  });
  expect(checkpoint.companies).toHaveLength(1);
  expect(checkpoint.companies[0]).toMatchObject({
    status: 'completed',
    contextComplete: false,
    receipt: {
      outcome: 'no_insight',
      effects: [],
      unpublishedDrafts: [{ assessment: unknown.assessment }],
    },
  });
  expect(analyze).not.toHaveBeenCalled();
  expect(calls).toEqual(['/internal/execution/company-plan', '/internal/execution/company-watch']);
});

it('completes a full model-free five-company job with no-insight receipts and no projected cards', async () => {
  // Static fake selection and already validated typed receipts, not live selection or model evaluation.
  const companyIds = Array.from(
    { length: 5 },
    (_, index) => `0000000${index + 1}-0000-4000-8000-000000000001`,
  );
  const flowRequest = flowRequestSchema.parse({
    newsMaterialId: 'news',
    newsVersionId: 'v1',
    asOf: time,
    projectionOnly: true,
  });
  const news = materialSchema.parse({
    ...sourceRef,
    sourceId: 'synthetic-only',
    kind: 'news',
    title: 'Synthetic',
    text: 'Synthetic news.',
    knownAt: time,
    companyIds: [],
    bankProfileIds: [],
  });
  let job: NewsJob = jobSchema.parse({
    request: {
      jobId: 'five-no-insight',
      newsMaterialId: 'news',
      newsVersionId: 'v1',
      asOf: time,
      parameters: flowRequest,
    },
    status: 'running',
    version: 1,
    workerId: 'fixture-worker',
    leaseUntil: time,
    checkpoint: {},
    error: null,
    updatedAt: time,
  });
  const calls: string[] = [];
  const backend: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith('/news-jobs/claim')) return Response.json(job);
    if (path.endsWith('/news-jobs/five-no-insight')) {
      const update = JSON.parse(String(init?.body));
      job = {
        ...job,
        ...update,
        checkpoint: structuredClone(update.checkpoint),
        version: job.version + 1,
      };
      return Response.json(job);
    }
    if (path.endsWith('/news/resolve')) return Response.json(news);
    if (path.endsWith('/search/sync')) return Response.json({});
    if (path.endsWith('/question-recipients'))
      return Response.json({ companyIds: [], nextCursor: null });
    if (path.endsWith('/knowledge/selection'))
      return Response.json({ groups: [], selectedCompanyIds: companyIds, pendingCompanyIds: [] });
    if (path.endsWith('/execution/company-plan')) {
      const { companyId: own } = JSON.parse(String(init?.body));
      return Response.json({
        analysisInput: { ...request, companyId: own },
        relevancePlan: {
          eventSummary: 'Synthetic',
          queries: ['unknown exposure'],
          generalInsights: [],
        },
        requiresWatchRegistration: false,
        watchAfterSequence: 0,
        relevanceSources: [],
        segmentKeys: [],
        receipt: {
          ...receipt,
          analysisId: `no-insight-${own}`,
          companyId: own,
          unpublishedDrafts: [{ ...unknown, literalObjectRef: `company:${own}` }],
        },
        depth: {
          policyVersion: 'evidence-depth-v1',
          level: 'canonical_projection',
          reason: 'projection_refresh',
          ownOriginalCount: 0,
          inventoryCompleteForLoadedScope: true,
          sourceRefs: [],
          generalInsightIndexes: [],
          applicability: 'unknown',
          missingFacts: [],
        },
      });
    }
    if (path.endsWith('/execution/company-watch'))
      return Response.json({ requests: [], afterSequence: 0, complete: true });
    if (path.endsWith('/projections/job'))
      return Response.json({
        canonicalCompanies: job.checkpoint.companies,
        roleScopes: [],
        roleViews: [],
        result: { rankedCompanyFacts: [], groups: [], roles: [] },
      });
    throw new Error(`Unexpected fake API ${path}`);
  };
  const jobs = new FlowJobClient('http://insight.test', 'fixture-only', backend);
  const analyze = vi.fn();
  const plan = vi.fn();
  const role = vi.fn();
  const analyzer = new NewsAnalyzer({
    context: new ContextClient('http://context.test', 'fixture-only', backend),
    insights: new InsightClient('http://insight.test', 'fixture-only', backend),
    reasoner: { analyze },
  });
  const flow = new NewsFlow({
    context: new FlowContextClient('http://context.test', 'fixture-only', backend),
    companies: new CompanyClient('http://company.test', 'fixture-only', backend),
    jobs,
    analyzer,
    reasoner: { plan, role },
  });
  await flow.tick();
  expect(job.status).toBe('completed');
  const checkpoint = checkpointSchema.parse(job.checkpoint);
  expect(checkpoint.companies.map((company) => company.companyId).sort()).toEqual(
    [...companyIds].sort(),
  );
  expect(
    checkpoint.companies.every(
      (company) =>
        company.status === 'completed' &&
        company.receipt?.outcome === 'no_insight' &&
        company.receipt.effects.length === 0,
    ),
  ).toBe(true);
  expect(
    checkpoint.companies.every(
      (company) =>
        company.receipt?.unpublishedDrafts?.[0]?.assessment?.unknowns[0]?.fact ===
        unknown.assessment.unknowns[0]?.fact,
    ),
  ).toBe(true);
  expect(checkpoint.result).toEqual({ rankedCompanyFacts: [], groups: [], roles: [] });
  expect(analyze).not.toHaveBeenCalled();
  expect(plan).not.toHaveBeenCalled();
  expect(role).not.toHaveBeenCalled();
  expect(calls.filter((path) => path.endsWith('/execution/company-plan'))).toHaveLength(5);
  expect(calls.some((path) => path.endsWith('/analyses'))).toBe(false);
});

it('retains mixed-scope unassessed coverage without turning missing assessment into complete totals', () => {
  const group = {
    groupId: 'group',
    companyIds: [companyId],
    complete: false,
    sourceRefs: [],
    totals: [],
    coverage: {
      expectedCompanies: 1,
      analyzedCompanies: 1,
      missingCompanyIds: [],
      missingGroups: [],
      cycles: [],
      unknownEffects: [],
      duplicateObjects: [],
      unrevisedEffectIds: [],
      emptyCompanyIds: [],
      partialContextCompanyIds: [],
      aggregationRuleConfirmed: true,
      unassessedCompanyIds: [companyId],
    },
  };
  const raw = {
    canonicalCompanies: [],
    roleScopes: [
      {
        key: 'role',
        scopeVersion: 'snapshot',
        profile: { personId: 'person', companyId, role: 'treasury', responsibilities: [] },
        facts: [],
        groups: [group],
      },
    ],
    roleViews: [],
    result: { coverage: { completeForSelectedScopes: false, unassessedCompanyIds: [companyId] } },
  };
  const parsed = jobProjectionSchema.parse(raw);
  expect(parsed.roleScopes[0]?.groups[0]?.coverage).toHaveProperty('unassessedCompanyIds', [
    companyId,
  ]);
  expect(parsed.roleScopes[0]?.groups[0]?.complete).toBe(false);
  expect(parsed.result).toEqual(raw.result);
  const { unassessedCompanyIds: _unassessed, ...legacyCoverage } = group.coverage;
  const legacy = jobProjectionSchema.parse({
    ...raw,
    roleScopes: [{ ...raw.roleScopes[0], groups: [{ ...group, coverage: legacyCoverage }] }],
  });
  expect(legacy.roleScopes[0]?.groups[0]?.coverage).not.toHaveProperty('unassessedCompanyIds');
});
