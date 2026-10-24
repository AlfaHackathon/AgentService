import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AssistantServiceClients } from '../src/client-assistant/service-clients.ts';
import { AssistantToolSession, initialAssistantState } from '../src/client-assistant/session.ts';
import type { AnalysisResult } from '../src/news-analysis/application/company-analysis.ts';
import type { materialSchema, StoredEffect } from '../src/news-analysis/contracts/analysis.ts';
import { NewsAnalysisError } from '../src/news-analysis/contracts/errors.ts';
import { ServiceClient } from '../src/news-analysis/transport/http/service-client.ts';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyId = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const asOf = '2026-10-24T00:00:00Z';
const ref = { materialId: 'contract', versionId: 'v2', contentHash: 'a'.repeat(64) };
const original: z.infer<typeof materialSchema> = {
  ...ref,
  sourceId: 'fixture',
  kind: 'company',
  title: 'Own contract',
  text: 'Own facts',
  companyIds: [companyId],
  bankProfileIds: ['U_96'],
  knownAt: asOf,
};
const publicNews: z.infer<typeof materialSchema> = {
  ...original,
  materialId: 'news',
  versionId: 'v1',
  kind: 'news',
  companyIds: [],
};
const receipt: AnalysisResult = {
  analysisId: 'saved-analysis',
  duplicate: false,
  companyId,
  newsMaterialId: 'news',
  newsVersionId: 'v1',
  asOf,
  completedAt: asOf,
  resultSemantics: 'saved_analysis_revisions_not_latest_heads',
  effects: [],
  reasoningInvoked: true,
  contextComplete: false,
};
const savedEffect: StoredEffect = {
  companyId,
  effectId: 'effect',
  effectKey: 'test',
  newsMaterialId: 'news',
  literalObjectRef: 'Own object',
  history: [],
  currentRevision: {
    revisionId: 'r1',
    previousRevisionId: null,
    newsVersionId: 'v1',
    asOf,
    createdAt: asOf,
    conclusion: 'Own effect',
    status: 'unknown',
    sourceRefs: [ref],
    impact: null,
  },
};

function setup() {
  const values = {
    owner: ownerId as string | null,
    membership: { id: companyId, name: 'Own company', bankProfileId: 'U_96' } as {
      id: string;
      name: string;
      bankProfileId: string | null;
    } | null,
    profile: {
      companyId,
      name: 'Own company',
      revisionId: 'p1',
      bankProfileId: 'U_96',
      description: 'Own profile',
      industryCodes: [],
      exposures: [],
      knownAt: asOf,
      sourceRefs: [ref],
    },
    search: { hits: [{ companyId, sourceRefs: [ref], excerpt: 'Own facts' }], exhaustive: false },
    material: original,
    news: publicNews,
    effects: { effects: [] as StoredEffect[] },
    saved: null as AnalysisResult | null,
    error: false,
  };
  const calls: { url: URL; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    expect(new Headers(options?.headers).get('X-Internal-Secret')).toBe('fixture-secret');
    expect(options?.redirect).toBe('error');
    const url = new URL(String(input));
    calls.push({ url, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (values.error)
      return Response.json(
        { code: 'ASSISTANT_LEAK', message: 'fixture-secret foreign-data' },
        { status: 403 },
      );
    if (url.pathname.includes('/by-user/'))
      return values.membership
        ? Response.json(values.membership)
        : Response.json({ errorMessage: 'no membership' }, { status: 404 });
    if (url.pathname.includes('/knowledge/companies/')) return Response.json(values.profile);
    if (url.pathname.endsWith('/search')) return Response.json(values.search);
    if (url.pathname.includes('/material-versions/')) return Response.json(values.material);
    if (url.pathname.endsWith('/news/resolve')) return Response.json(values.news);
    if (url.pathname.endsWith('/effects')) return Response.json(values.effects);
    if (url.pathname.endsWith('/analyses'))
      return values.saved
        ? Response.json(values.saved)
        : Response.json({ errorMessage: 'no receipt' }, { status: 404 });
    throw new Error('Unexpected fixture request');
  };
  const clients = new AssistantServiceClients(
    new ServiceClient('http://fixture.test/company-service', 'fixture-secret', fetcher),
    new ServiceClient('http://fixture.test/context-service', 'fixture-secret', fetcher),
    new ServiceClient('http://fixture.test/insight-service', 'fixture-secret', fetcher),
  );
  const analyze = vi.fn(async () => receipt);
  const owner = vi.fn(async (_id: string) => values.owner);
  const state = { ...initialAssistantState(), asOf };
  const persist = vi.fn();
  const session = new AssistantToolSession(
    chatId,
    state,
    async () => ({ clients, owner, analyzer: { analyze } }),
    persist,
  );
  const run = async (action: () => Promise<unknown>) =>
    JSON.parse((await session.run(action)).output);
  return { values, calls, session, state, analyze, owner, persist, run };
}

describe('conversational service boundary (no live model)', () => {
  it('binds every request to the persisted chat owner and membership, with exact existing wire contracts', async () => {
    const s = setup();
    expect(await s.run(() => s.session.profile())).toMatchObject({
      profile: { name: 'Own company' },
    });
    expect(await s.run(() => s.session.search('contract'))).toMatchObject({
      hits: [{ sources: [{ sourceHandle: 's0' }] }],
    });
    expect(await s.run(() => s.session.read('s0'))).toMatchObject({
      original: { text: 'Own facts' },
    });
    expect(await s.run(() => s.session.effects('news'))).toMatchObject({
      total: 0,
      hasMore: false,
    });
    expect(s.owner).toHaveBeenCalledWith(chatId);
    expect(s.calls.filter((c) => c.url.pathname.includes('/by-user/'))).toHaveLength(4);
    expect(s.calls.find((c) => c.url.pathname.endsWith('/search'))?.body).toEqual({
      companyId,
      query: 'contract',
      asOf,
      limit: 6,
      publicOnly: false,
    });
    expect(
      s.calls.find((c) => c.url.pathname.endsWith('/effects'))?.url.searchParams.get('companyId'),
    ).toBe(companyId);
    expect(s.calls.some((c) => c.url.pathname.includes(ownerId))).toBe(true);
    expect(s.analyze).not.toHaveBeenCalled();
  });

  it('fails closed without a trusted owner or company membership', async () => {
    const s = setup();
    s.values.owner = null;
    expect(await s.run(() => s.session.profile())).toMatchObject({ code: 'ASSISTANT_NO_OWNER' });
    expect(s.calls).toHaveLength(0);
    s.values.owner = ownerId;
    s.values.membership = null;
    expect(await s.run(() => s.session.analyze('news', 'v1'))).toMatchObject({
      code: 'ASSISTANT_NO_COMPANY',
    });
    expect(s.calls).toHaveLength(1);
    expect(s.analyze).not.toHaveBeenCalled();
  });

  it('pages through scoped effects without silently losing the rest of a bounded result', async () => {
    const s = setup();
    s.values.effects.effects = Array.from({ length: 9 }, (_, i) => ({
      ...savedEffect,
      effectId: `effect-${i}`,
    }));
    expect(await s.run(() => s.session.effects('news', 0, 1))).toMatchObject({
      total: 9,
      hasMore: true,
      nextOffset: 1,
      effects: [{ effectId: 'effect-0' }],
    });
    expect(await s.run(() => s.session.effects('news', 8, 1))).toMatchObject({
      total: 9,
      hasMore: false,
      nextOffset: null,
      effects: [{ effectId: 'effect-8' }],
    });
  });

  it.each(['company', 'hash', 'time', 'identity', 'unscoped-company'])(
    'rechecks original %s before disclosure or reassessment',
    async (kind) => {
      const s = setup();
      await s.run(() => s.session.search('contract'));
      if (kind === 'company') s.values.material = { ...original, companyIds: [foreignId] };
      if (kind === 'hash') s.values.material = { ...original, contentHash: 'b'.repeat(64) };
      if (kind === 'time')
        s.values.material = { ...original, knownAt: '2026-10-24T00:00:00.0000001Z' };
      if (kind === 'identity') s.values.material = { ...original, materialId: 'different' };
      if (kind === 'unscoped-company') s.values.material = { ...original, companyIds: [] };
      expect(await s.run(() => s.session.read('s0'))).toMatchObject({
        code: 'ASSISTANT_SOURCE_SCOPE',
      });
      expect(await s.run(() => s.session.analyze('news', 'v1', 's0'))).toMatchObject({
        code: 'ASSISTANT_SOURCE_SCOPE',
      });
      expect(s.analyze).not.toHaveBeenCalled();
    },
  );

  it('does not read arbitrary versions or reuse a handle after membership changes', async () => {
    const s = setup();
    expect(await s.run(() => s.session.read('s999'))).toMatchObject({
      code: 'ASSISTANT_SOURCE_SCOPE',
    });
    await s.run(() => s.session.search('contract'));
    s.values.membership = { id: foreignId, name: 'Changed membership', bankProfileId: null };
    expect(await s.run(() => s.session.read('s0'))).toMatchObject({
      code: 'ASSISTANT_SOURCE_SCOPE',
    });
    expect(s.calls.some((c) => c.url.pathname.includes('/material-versions/'))).toBe(false);
  });

  it('bounds the source catalogue and keeps every returned handle usable', async () => {
    const s = setup();
    await s.run(() => s.session.search('previous'));
    s.values.search.hits = Array.from({ length: 6 }, (_, hit) => ({
      companyId,
      excerpt: 'Own facts',
      sourceRefs: Array.from({ length: 6 }, (_, source) => ({
        ...ref,
        materialId: `source-${hit}-${source}`,
      })),
    }));
    const result = await s.run(() => s.session.search('new sources'));
    expect(result).toMatchObject({ exhaustive: false, omittedSourceRefs: 12 });
    expect(s.state.sources).toHaveLength(24);
    const returned = z
      .object({
        hits: z.array(z.object({ sources: z.array(z.object({ sourceHandle: z.string() })) })),
      })
      .parse(result);
    for (const source of returned.hits.flatMap((hit) => hit.sources)) {
      expect(s.state.sources.some((saved) => saved.handle === source.sourceHandle)).toBe(true);
    }
  });

  it('rejects foreign profiles, search hits and effects instead of exposing them', async () => {
    const s = setup();
    s.values.profile.companyId = foreignId;
    expect(await s.run(() => s.session.profile())).toMatchObject({
      code: 'ASSISTANT_PROFILE_SCOPE',
    });
    s.values.search.hits[0] = { companyId: foreignId, sourceRefs: [ref], excerpt: 'foreign-data' };
    expect(await s.run(() => s.session.search('contract'))).toMatchObject({
      code: 'ASSISTANT_SEARCH_SCOPE',
    });
    s.values.effects.effects = [
      {
        companyId: foreignId,
        effectId: 'foreign-effect',
        effectKey: 'test',
        newsMaterialId: 'news',
        literalObjectRef: 'foreign-data',
        history: [],
        currentRevision: {
          revisionId: 'r1',
          previousRevisionId: null,
          newsVersionId: 'v1',
          asOf,
          createdAt: asOf,
          conclusion: 'foreign-data',
          status: 'unknown',
          sourceRefs: [ref],
          impact: null,
        },
      },
    ];
    const output = await s.run(() => s.session.effects('news'));
    expect(output).toMatchObject({ code: 'ASSISTANT_EFFECT_SCOPE' });
    expect(JSON.stringify(output)).not.toContain('foreign-data');
  });

  it('runs the existing single-company analyzer with server scope and an exact permitted trigger', async () => {
    const s = setup();
    await s.run(() => s.session.search('contract'));
    s.analyze.mockResolvedValue({
      ...receipt,
      trigger: { materialId: 'contract', versionId: 'v2' },
    });
    expect(await s.run(() => s.session.analyze('news', 'v1', 's0'))).toMatchObject({
      status: 'completed',
      contextComplete: false,
      effectCount: 0,
    });
    expect(s.analyze).toHaveBeenCalledExactlyOnceWith({
      companyId,
      bankProfileId: 'U_96',
      newsMaterialId: 'news',
      newsVersionId: 'v1',
      asOf,
      trigger: { materialId: 'contract', versionId: 'v2' },
    });
    expect(await s.run(() => s.session.analyze('news', 'v1'))).toMatchObject({
      code: 'ASSISTANT_ANALYSIS_BUDGET',
    });
    expect(s.analyze).toHaveBeenCalledTimes(1);
  });

  it('reuses saved receipts without claiming fresh reasoning and denies private news', async () => {
    const s = setup();
    s.values.saved = receipt;
    expect(await s.run(() => s.session.analyze('news', 'v1'))).toMatchObject({
      status: 'completed',
      duplicate: true,
    });
    expect(s.analyze).not.toHaveBeenCalled();
    s.values.news = { ...publicNews, companyIds: [foreignId] };
    expect(await s.run(() => s.session.analyze('news', 'v1'))).toMatchObject({
      code: 'ASSISTANT_NEWS_SCOPE',
    });
  });

  it('preserves duplicate semantics when a concurrent job completes after the receipt check', async () => {
    const s = setup();
    s.analyze.mockResolvedValue({ ...receipt, duplicate: true, reasoningInvoked: false });
    expect(await s.run(() => s.session.analyze('news', 'v1'))).toMatchObject({
      status: 'completed',
      duplicate: true,
    });
    expect(s.analyze).toHaveBeenCalledTimes(1);
  });

  it('checks a failed analysis outcome once without blindly retrying the write', async () => {
    const s = setup();
    s.analyze.mockImplementation(async () => {
      throw new Error('fixture-secret');
    });
    const result = await s.run(() => s.session.analyze('news', 'v1'));
    expect(result).toMatchObject({ status: 'unknown', code: 'ANALYSIS_OUTCOME_UNKNOWN' });
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(s.analyze).toHaveBeenCalledTimes(1);
    expect(s.calls.filter((c) => c.url.pathname.endsWith('/analyses'))).toHaveLength(2);
    const committed = setup();
    committed.analyze.mockImplementation(async () => {
      committed.values.saved = receipt;
      throw new Error('response lost');
    });
    expect(await committed.run(() => committed.session.analyze('news', 'v1'))).toMatchObject({
      status: 'completed',
      duplicate: true,
    });
    expect(committed.analyze).toHaveBeenCalledTimes(1);
  });

  it('bounds originals and cumulative outputs, persists call budgets, and redacts upstream errors', async () => {
    const s = setup();
    await s.run(() => s.session.search('contract'));
    s.values.material = { ...original, text: 'x'.repeat(24001) };
    expect(await s.run(() => s.session.read('s0'))).toMatchObject({ code: 'OUTPUT_BUDGET' });
    s.values.error = true;
    const error = await s.run(() => s.session.profile());
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(JSON.stringify(error)).not.toMatch(/fixture-secret|foreign-data/);
    s.state.calls = 8;
    const before = s.calls.length;
    expect(await s.run(() => s.session.profile())).toMatchObject({ code: 'TOOL_BUDGET' });
    expect(s.calls).toHaveLength(before);
    s.state.calls = 0;
    s.state.outputCharacters = 59000;
    expect(await s.run(async () => 'x'.repeat(2000))).toMatchObject({ code: 'OUTPUT_BUDGET' });
    expect(s.persist).toHaveBeenCalled();
  });

  it('returns a stable timeout error without the upstream message', async () => {
    const s = setup();
    expect(
      await s.run(async () => {
        throw new NewsAnalysisError(502, 'UPSTREAM_TIMEOUT', 'fixture-secret');
      }),
    ).toMatchObject({ code: 'SERVICE_TIMEOUT' });
  });
});
