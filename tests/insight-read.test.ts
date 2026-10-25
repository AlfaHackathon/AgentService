import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApplication, mountService } from '../src/application.ts';
import { ChatRepository } from '../src/chats/repository.ts';
import { createInsightReadDependencies } from '../src/insights/configuration.ts';
import { createInsightReadRoutes } from '../src/insights/routes.ts';
import {
  personalCardSchema,
  publicHistorySchema,
  storedRevisionSchema,
} from '../src/insights/schemas.ts';
import type { InsightReadDependencies } from '../src/insights/service.ts';
import { materialSchema } from '../src/news-analysis/contracts/analysis.ts';
import { NewsAnalysisError } from '../src/news-analysis/contracts/errors.ts';

const company = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const at = '2026-10-25T00:00:00Z';
function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Fixture expected a value');
  return value;
}
function material(id: string, kind: 'news' | 'company' | 'market', companyIds: string[] = []) {
  return materialSchema.parse({
    materialId: id,
    versionId: 'v1',
    sourceId: 'synthetic',
    kind,
    title: id,
    text: 'NEVER RETURN ORIGINAL TEXT',
    knownAt: at,
    companyIds,
    bankProfileIds: [],
    contentHash: 'a'.repeat(64),
    provenance: {
      acquisition: 'uploaded',
      sourceUrl: 'https://example.test/original',
      retrievedAt: at,
      textCompleteness: 'lead',
      originVersionId: null,
      locator: 'PRIVATE-LOCATOR',
    },
  });
}
const news = material('news', 'news');
const own = material('own', 'company', [company]);
const ref = ({ materialId, versionId, contentHash }: typeof news) => ({
  materialId,
  versionId,
  contentHash,
});
function revision() {
  return storedRevisionSchema.parse({
    revisionId: 'revision-2',
    previousRevisionId: 'revision-1',
    newsMaterialId: 'news',
    newsVersionId: 'v1',
    asOf: at,
    createdAt: at,
    conclusion: 'Synthetic sourced consequence',
    status: 'forecast',
    publicationClass: 'scenario',
    modelExplanation: 'PRIVATE-AUDIT',
    sourceRefs: [ref(news), ref(own)],
    question: {
      mechanism: 'input_cost',
      frame: 'event_only',
      unit: 'RUB',
      targetPeriod: '2026-11',
      baselinePeriod: null,
    },
    impact: {
      metric: 'expense_delta',
      amountBasis: 'contract_total',
      economicObjectId: null,
      evidenceStatus: 'conditional',
      importance: 4,
      urgency: 5,
      novelty: 3,
    },
    calculation: {
      expression: { kind: 'value', value: '12345678901234567890.1234' },
      unit: 'RUB',
      period: '2026-11',
    },
    calculationResult: '12345678901234567890.1234',
    calculationArithmeticOnly: true,
    companyImportance: {
      score: 4,
      rationale: 'Synthetic own company exposure requires review.',
      evidenceRefs: [ref(own)],
    },
  });
}
function personal() {
  return {
    id: 'question-1',
    companyId: company,
    newsMaterialId: 'news',
    literalObjectRef: `company:${company}`,
    currentRevision: revision(),
    requiresReassessment: false,
  };
}
function general() {
  return {
    id: 'opaque-general',
    companyId: company,
    jobId: 'job-1',
    insightIndex: 23,
    newsMaterialId: 'news',
    newsVersionId: 'v1',
    asOf: at,
    updatedAt: at,
    textCompleteness: 'lead',
    companyStatus: 'completed',
    insight: {
      title: 'Synthetic general result',
      conclusion: 'Public source result',
      mechanism: 'Input costs',
      applicability: ['If exposed'],
      exclusions: [],
      unknowns: ['Company amount unknown'],
      sourceRefs: [ref(news)],
    },
    rawCheckpoint: 'PRIVATE-CHECKPOINT',
    otherCompanies: [foreign],
  };
}
function fixture() {
  const item = personal();
  const materials = new Map([news, own].map((s) => [s.materialId, s]));
  const read = vi.fn(
    async (path: string): Promise<unknown> =>
      path.includes('/history?')
        ? { companyId: company, items: [item.currentRevision], nextCursor: null }
        : path.includes('?')
          ? { companyId: company, items: [item], nextCursor: 'opaque-next' }
          : item,
  );
  const dependencies = {
    membership: vi.fn(
      async (): Promise<{ id: string; name: string; bankProfileId: string | null } | null> => ({
        id: company,
        name: 'Synthetic company',
        bankProfileId: null,
      }),
    ),
    material: vi.fn(async (id: string) => materials.get(id) ?? null),
    read,
  };
  const factory = vi.fn(() => dependencies satisfies InsightReadDependencies);
  const app = mountService(
    createApplication({
      chats: new ChatRepository({
        query: async () => {
          throw new Error('Unexpected chat/storage access');
        },
      }),
      agentRouter: new Hono(),
      insightRouter: createInsightReadRoutes(factory),
      ready: async () => {},
      log: () => {},
    }),
  );
  const request = (path = '/insights', headers: Record<string, string> = { 'X-User-Id': user }) =>
    app.request(`/agent-service${path}`, { headers });
  return { item, materials, dependencies, factory, app, request };
}

describe('public insight reads through mounted gateway identity boundary', () => {
  it('requires trusted user context before resolving any dependency and does not accept internal secret as identity', async () => {
    const f = fixture();
    for (const path of [
      '/insights',
      '/insights/personal/question-1',
      '/insights/personal/question-1/history',
    ])
      expect((await f.request(path, { 'X-Internal-Secret': 'not-user-auth' })).status).toBe(401);
    expect(f.factory).not.toHaveBeenCalled();
  });
  it.each([
    `companyId=${foreign}`,
    'personId=p',
    `asOf=${at}`,
    'limit=21',
    'limit=0',
    'limit=1&limit=2',
    'kind=general&minImportance=2',
    'minImportance=0',
    'kind=other',
    '__proto__=other',
    'constructor=other',
    'mechanism=other',
  ])('rejects unsupported input %s before service reads', async (query) => {
    const f = fixture();
    expect((await f.request(`/insights?${query}`)).status).toBe(400);
    expect(f.factory).not.toHaveBeenCalled();
  });
  it('returns current scoped revision and truthful source metadata, without audit/legacy ranking/AST/source text', async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const payload = await response.json();
    const card = personalCardSchema.parse(payload.items[0]);
    expect(f.dependencies.membership).toHaveBeenCalledWith(user);
    expect(f.dependencies.read).toHaveBeenCalledWith(
      `/internal/read/companies/${company}/personal?limit=5`,
    );
    expect(card.currentRevision.companyImportance?.score).toBe(4);
    expect(card.currentRevision.companyImportance?.rationale).toContain('exposure');
    expect(card.sources[0]?.provenance).toMatchObject({
      sourceUrl: 'https://example.test/original',
      textCompleteness: 'lead',
    });
    expect(card.indicators[0]).toMatchObject({
      value: '12345678901234567890.1234',
      unit: 'RUB',
      period: '2026-11',
      evidenceStatus: 'conditional',
      baselinePeriod: null,
      arithmeticOnly: true,
    });
    const json = JSON.stringify(payload);
    for (const secret of [
      'PRIVATE',
      'NEVER RETURN',
      '"urgency"',
      '"novelty"',
      '"importance"',
      '"expression"',
      '"bankProfileIds"',
      '"companyIds"',
    ])
      expect(json).not.toContain(secret);
    expect(payload).toMatchObject({
      companyId: company,
      nextCursor: 'opaque-next',
      exhaustive: false,
    });
  });
  it('forwards validated filters/cursor and derives company afresh for every read', async () => {
    const f = fixture();
    await f.request(
      '/insights?limit=1&cursor=opaque&minImportance=3&status=unknown&mechanism=input_cost&newsMaterialId=news',
    );
    expect(f.dependencies.read.mock.calls[0]?.[0]).toBe(
      `/internal/read/companies/${company}/personal?limit=1&cursor=opaque&status=unknown&mechanism=input_cost&newsMaterialId=news&minImportance=3`,
    );
    f.dependencies.membership.mockResolvedValue(null);
    expect((await f.request('/insights/personal/question-1')).status).toBe(403);
    expect(f.dependencies.read).toHaveBeenCalledTimes(1);
  });
  it('does not expose old legacy importance as company importance', async () => {
    const f = fixture();
    delete f.item.currentRevision.companyImportance;
    const body = await (await f.request('/insights/personal/question-1')).json();
    expect(body.currentRevision.companyImportance).toBeNull();
    expect(body.currentRevision.impact).not.toHaveProperty('importance');
  });
  it('preserves explicit not-assessed rationale with null score', async () => {
    const f = fixture();
    f.item.currentRevision.companyImportance = {
      score: null,
      rationale: 'Company exposure is unknown.',
      evidenceRefs: [],
    };
    present(f.item.currentRevision.impact).importance = 0;
    expect((await (await f.request()).json()).items[0].currentRevision.companyImportance).toEqual({
      score: null,
      rationale: 'Company exposure is unknown.',
      evidenceRefs: [],
    });
  });
  it.each(['hash', 'knownAt', 'importance'])(
    'fails closed for incompatible %s evidence',
    async (kind) => {
      const f = fixture();
      if (kind === 'hash') f.materials.set('own', { ...own, contentHash: 'b'.repeat(64) });
      if (kind === 'knownAt') f.materials.set('own', { ...own, knownAt: '2026-10-26T00:00:00Z' });
      if (kind === 'importance')
        present(f.item.currentRevision.companyImportance).evidenceRefs = [ref(news)];
      expect((await f.request()).status).toBe(502);
    },
  );
  it.each(['company', 'bank'])(
    'omits private %s-source cards but preserves continuation and hides detail/history',
    async (kind) => {
      const f = fixture();
      f.materials.set('own', {
        ...own,
        ...(kind === 'company' ? { companyIds: [foreign] } : { bankProfileIds: ['U_99'] }),
      });
      expect(await (await f.request()).json()).toMatchObject({
        items: [],
        nextCursor: 'opaque-next',
        exhaustive: false,
      });
      expect((await f.request('/insights/personal/question-1')).status).toBe(404);
      expect((await f.request('/insights/personal/question-1/history')).status).toBe(404);
    },
  );
  it('permits a source tied to the current membership bank, not an arbitrary bank', async () => {
    const f = fixture();
    f.dependencies.membership.mockResolvedValue({
      id: company,
      name: 'Synthetic',
      bankProfileId: 'U_99',
    });
    f.materials.set('own', { ...own, bankProfileIds: ['U_99'] });
    expect((await f.request()).status).toBe(200);
  });
  it('rejects other-company upstream rows before resolving their material ids', async () => {
    const f = fixture();
    f.item.companyId = foreign;
    expect((await f.request()).status).toBe(502);
    expect(f.dependencies.material).not.toHaveBeenCalled();
    expect((await f.request('/insights/personal/question-1')).status).toBe(404);
    expect(f.dependencies.material).not.toHaveBeenCalled();
  });
  it('distinguishes unavailable exact sources/backend from a successful empty feed and sanitizes upstream errors', async () => {
    const f = fixture();
    f.materials.delete('own');
    expect((await f.request()).status).toBe(503);
    f.dependencies.read.mockResolvedValue(null);
    expect((await f.request()).status).toBe(503);
    expect((await f.request('/insights/personal/question-1')).status).toBe(404);
    f.dependencies.read.mockRejectedValue(
      new NewsAnalysisError(502, 'PRIVATE', 'PRIVATE-UPSTREAM-SECRET'),
    );
    const failed = await f.request();
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('PRIVATE');
  });
  it('maps invalid upstream cursor to a safe 400 and bounds source reads', async () => {
    const f = fixture();
    f.dependencies.read.mockRejectedValue(new NewsAnalysisError(400, 'BAD_CURSOR', 'PRIVATE'));
    expect((await f.request()).status).toBe(400);
    f.dependencies.read.mockResolvedValue({
      companyId: company,
      items: Array.from({ length: 2 }, (_, i) => ({
        ...f.item,
        id: `q${i}`,
        currentRevision: {
          ...revision(),
          sourceRefs: Array.from({ length: 33 }, (_, j) => ({
            ...ref(own),
            materialId: `m${i}-${j}`,
          })),
        },
      })),
      nextCursor: null,
    });
    expect((await f.request()).status).toBe(503);
    expect(f.dependencies.material).not.toHaveBeenCalled();
  });
  it.each(['javascript:alert(1)', 'https://user:pass@example.test/source'])(
    'does not publish unsafe sourceUrl %s',
    async (sourceUrl) => {
      const f = fixture();
      f.materials.set('news', { ...news, provenance: { ...present(news.provenance), sourceUrl } });
      const payload = await (await f.request()).json();
      expect(payload.items[0].sources[0].provenance.sourceUrl).toBeNull();
    },
  );
  it('does not fabricate absent source provenance', async () => {
    const f = fixture();
    f.materials.set('news', { ...news, provenance: null });
    expect((await (await f.request()).json()).items[0].sources[0].provenance).toBeNull();
  });
  it('returns bounded revision history with the same filtered read contract', async () => {
    const f = fixture();
    const response = await f.request('/insights/personal/question-1/history?limit=1&cursor=opaque');
    expect(response.status).toBe(200);
    const payload = publicHistorySchema.parse(await response.json());
    expect(payload.items[0]?.revision.revisionId).toBe('revision-2');
    expect(payload.items[0]?.indicators[0]?.value).toBe('12345678901234567890.1234');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE-AUDIT');
    expect(f.dependencies.read.mock.calls[1]?.[0]).toContain(
      '/question-1/history?limit=1&cursor=opaque',
    );
  });
  it('projects general result only, including segment index 23, without company score/calculation or raw job data', async () => {
    const f = fixture();
    const g = general();
    f.dependencies.read.mockImplementation(async (path) =>
      path.includes('?') ? { companyId: company, items: [g], nextCursor: null } : g,
    );
    const response = await f.request('/insights?kind=general');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.items[0]).toMatchObject({
      kind: 'general',
      textCompleteness: 'lead',
      requiresReassessment: null,
      indicators: [],
      indicatorAvailability: { reason: 'general_not_company_calculation' },
    });
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE|otherCompanies|companyImportance|jobId/);
    expect((await f.request('/insights/general/opaque-general')).status).toBe(200);
    f.materials.set('news', { ...news, companyIds: [company] });
    expect((await (await f.request('/insights?kind=general')).json()).items).toEqual([]);
  });
  it('has no generator/write/deepen/feedback/general history route', async () => {
    const f = fixture();
    for (const path of ['/insights/general/opaque/history', '/insights/personal/question-1/deepen'])
      expect((await f.request(path)).status).toBe(404);
    expect(
      (
        await f.app.request('/agent-service/insights', {
          method: 'POST',
          headers: { 'X-User-Id': user },
        })
      ).status,
    ).toBe(404);
    expect(f.factory).not.toHaveBeenCalled();
  });
  it('does not require inference settings to configure its read-only clients', () => {
    expect(() =>
      createInsightReadDependencies({
        COMPANY_SERVICE_URL: 'http://company.test/company-service',
        CONTEXT_SERVICE_URL: 'http://context.test/context-service',
        INSIGHT_SERVICE_URL: 'http://insight.test/insight-service',
        INTERNAL_SECRET: 'fake-test-secret',
      }),
    ).not.toThrow();
  });
});

describe('optional sourced calculation indicators', () => {
  it.each(['stale', 'unknown', 'no_calculation', 'null', 'unknown_period', 'unknown_baseline'])(
    'suppresses unsupported %s values without null-to-zero',
    async (kind) => {
      const f = fixture();
      const r = f.item.currentRevision;
      if (kind === 'stale') f.item.requiresReassessment = true;
      if (kind === 'unknown') present(r.impact).evidenceStatus = 'unknown';
      if (kind === 'no_calculation') r.calculation = null;
      if (kind === 'null') r.calculationResult = null;
      if (kind === 'unknown_period') present(r.question).targetPeriod = 'unknown';
      if (kind === 'unknown_baseline') {
        present(r.question).frame = 'budget_delta';
        present(r.question).baselinePeriod = 'unknown';
      }
      const body = await (await f.request('/insights/personal/question-1')).json();
      expect(body.indicators).toEqual([]);
      expect(body.indicatorAvailability.reason).not.toBe('available');
      expect(body.currentRevision).not.toHaveProperty('calculation');
    },
  );
  it('preserves a proven zero as string and optional comparison baseline', async () => {
    const f = fixture();
    f.item.currentRevision.calculationResult = '0';
    present(f.item.currentRevision.question).frame = 'budget_delta';
    present(f.item.currentRevision.question).baselinePeriod = 'budget:2026-11';
    const body = await (await f.request()).json();
    expect(body.items[0].indicators[0]).toMatchObject({
      value: '0',
      baselinePeriod: 'budget:2026-11',
    });
  });
});
