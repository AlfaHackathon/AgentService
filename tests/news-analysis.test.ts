import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import {
  type AnalysisReceipt,
  type AnalysisRequest,
  analysisWriteSchema,
  type ContextBundle,
  type EffectDraft,
  type ReasoningInput,
  type StoredEffect,
} from '../src/news-analysis/contracts/analysis.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';
import { createNewsAnalysisRoutes } from '../src/news-analysis/transport/http/routes.ts';
import { createHttpService } from './helpers/http-service.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const secret = 'local-test-internal-secret';
const time = '2026-10-22T08:00:00Z';
const request: AnalysisRequest = {
  companyId,
  bankProfileId: 'U_96',
  newsMaterialId: 'synthetic-tariff-news',
  newsVersionId: 'v1',
  asOf: time,
};

function bundle(version: string): ContextBundle {
  const news = {
    materialId: request.newsMaterialId,
    versionId: version,
    sourceId: 'synthetic-news-source',
    kind: 'news' as const,
    title: 'Synthetic tariff news',
    text: version === 'v1' ? 'Synthetic tariff becomes 450.' : 'Synthetic correction to 360.',
    knownAt: time,
    companyIds: [],
    bankProfileIds: [],
    contentHash: (version === 'v1' ? '1' : '2').repeat(64),
  };
  return {
    news,
    materials: [
      {
        ...news,
        materialId: 'synthetic-contract',
        versionId: 'signed-1',
        sourceId: 'synthetic-contract-source',
        kind: 'company',
        title: 'Synthetic signed order',
        text: 'Synthetic signed order: 104 units, baseline 300.',
        companyIds: [companyId],
        bankProfileIds: ['U_96'],
        contentHash: 'c'.repeat(64),
      },
    ],
    coverage: {
      complete: true,
      materialCount: 1,
      companyMaterialCount: 1,
      marketMaterialCount: 0,
      previousNewsVersionCount: 0,
      characters: 100,
      asOf: time,
    },
  };
}

function draft(context: ContextBundle): EffectDraft {
  return {
    effectKey: 'tariff:lot-11',
    literalObjectRef: 'SYNTHETIC-LOT-11',
    conclusion: 'Synthetic planned incremental cost; not an incurred expense.',
    status: 'forecast',
    sourceRefs: [context.news, ...context.materials].map((source) => ({
      materialId: source.materialId,
      versionId: source.versionId,
      contentHash: source.contentHash,
    })),
    calculation: {
      expression: {
        kind: 'multiply',
        left: {
          kind: 'subtract',
          left: { kind: 'value', value: context.news.versionId === 'v1' ? '450' : '360' },
          right: { kind: 'value', value: '300' },
        },
        right: { kind: 'value', value: '104' },
      },
      unit: 'RUB',
      period: 'Synthetic planned acceptance',
    },
  };
}

describe('internal news analysis through actual HTTP clients', () => {
  const services: Awaited<ReturnType<typeof createHttpService>>[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  async function setup() {
    const receipts = new Map<string, AnalysisReceipt>();
    const effects = new Map<string, StoredEffect>();
    const writes: unknown[] = [];
    let rejectSave = false;
    const service = await createHttpService(async (incoming) => {
      if (incoming.headers.get('X-Internal-Secret') !== secret)
        return Response.json(
          { code: 'FORBIDDEN', message: 'Internal context required' },
          { status: 403 },
        );
      const url = new URL(incoming.url);
      if (url.pathname === '/insight-service/internal/calculations/preview') {
        expect(await incoming.json()).toEqual([]);
        return Response.json({ results: [] });
      }
      if (url.pathname === '/context-service/internal/context') {
        const body = await incoming.json();
        return Response.json(bundle(body.newsVersionId));
      }
      if (url.pathname === '/insight-service/internal/analyses/prepare') {
        const body = await incoming.json();
        if (
          body.drafts.some(
            (draft: EffectDraft) =>
              effects.has(draft.effectKey) &&
              effects.get(draft.effectKey)?.literalObjectRef !== draft.literalObjectRef,
          )
        )
          return Response.json(
            { errorMessage: 'An existing effect must retain its literal object reference' },
            { status: 422 },
          );
        return Response.json({
          drafts: body.drafts.map((draft: EffectDraft) => ({
            ...draft,
            expectedPreviousRevisionId:
              effects.get(draft.effectKey)?.currentRevision.revisionId ?? null,
          })),
        });
      }
      if (url.pathname === '/insight-service/internal/analyses/session') {
        const input = await incoming.json();
        const receipt = receipts.get(input.newsVersionId);
        if (
          receipt &&
          (receipt.asOf !== input.asOf ||
            (receipt.bankProfileId ?? null) !== (input.bankProfileId ?? null))
        )
          return Response.json(
            { errorMessage: 'This news version was processed with different analysis parameters' },
            { status: 409 },
          );
        return Response.json({
          receipt: receipt ? { ...receipt, duplicate: true } : null,
          previousEffects: [...effects.values()],
        });
      }
      if (url.pathname === '/insight-service/internal/effects')
        return Response.json({ effects: [...effects.values()] });
      if (url.pathname === '/insight-service/internal/analyses' && incoming.method === 'GET') {
        const receipt = receipts.get(url.searchParams.get('newsVersionId') ?? '');
        return receipt
          ? Response.json(receipt)
          : Response.json({ code: 'NOT_FOUND', message: 'Not processed' }, { status: 404 });
      }
      if (url.pathname === '/insight-service/internal/analyses' && incoming.method === 'POST') {
        const body = analysisWriteSchema.parse(await incoming.json());
        if (new Set(body.drafts.map((draft) => draft.effectKey)).size !== body.drafts.length)
          return Response.json(
            { errorMessage: 'Draft batch repeats an effect key' },
            { status: 422 },
          );
        writes.push(body);
        if (rejectSave)
          return Response.json(
            { code: 'INVALID_SOURCE', message: 'Source hash mismatch' },
            { status: 422 },
          );
        const saved: AnalysisReceipt['effects'] = [];
        for (const proposal of body.drafts) {
          const old = effects.get(proposal.effectKey);
          if ((old?.currentRevision.revisionId ?? null) !== proposal.expectedPreviousRevisionId)
            return Response.json(
              { code: 'STALE_PRIOR', message: 'Revision has changed' },
              { status: 409 },
            );
          const revision = {
            revisionId: `revision-${body.newsVersionId}-${proposal.effectKey}`,
            previousRevisionId: old?.currentRevision.revisionId ?? null,
            newsVersionId: body.newsVersionId,
            asOf: body.asOf,
            conclusion: proposal.conclusion,
            status: proposal.status,
            sourceRefs: proposal.sourceRefs,
            ...(proposal.calculation ? { calculation: proposal.calculation } : {}),
            createdAt: time,
          };
          const effect = {
            effectId: old?.effectId ?? `effect-${proposal.effectKey}`,
            effectKey: proposal.effectKey,
            companyId,
            newsMaterialId: body.newsMaterialId,
            literalObjectRef: proposal.literalObjectRef,
            currentRevision: revision,
            history: [...(old?.history ?? []), revision],
          };
          effects.set(effect.effectKey, effect);
          saved.push({
            effectId: effect.effectId,
            revisionId: revision.revisionId,
            previousRevisionId: revision.previousRevisionId,
            duplicate: false,
            currentRevision: revision,
          });
        }
        const receipt: AnalysisReceipt = {
          ...body,
          analysisId: `analysis-${body.newsVersionId}`,
          duplicate: false,
          completedAt: time,
          resultSemantics: 'saved_analysis_revisions_not_latest_heads',
          effects: saved,
        };
        receipts.set(body.newsVersionId, receipt);
        return Response.json(receipt);
      }
      return Response.json({ code: 'UNEXPECTED_PATH', message: url.pathname }, { status: 404 });
    });
    services.push(service);
    const analyze = vi.fn(async (input: ReasoningInput) => [draft(input.context)]);
    const clients = {
      context: new ContextClient(`${service.url}/context-service`, secret),
      insights: new InsightClient(`${service.url}/insight-service`, secret),
      reasoner: { analyze },
    };
    const makeAnalyzer = () => new NewsAnalyzer(clients);
    const analyzer = makeAnalyzer();
    const app = new Hono().route(
      '/agent-service/internal/news-analysis',
      createNewsAnalysisRoutes({ internalSecret: secret, analyzer }),
    );
    const post = (body: unknown, credential: string | undefined = secret) =>
      app.request('/agent-service/internal/news-analysis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(credential ? { 'X-Internal-Secret': credential } : {}),
        },
        body: JSON.stringify(body),
      });
    return {
      analyze,
      analyzer,
      app,
      post,
      makeAnalyzer,
      receipts,
      effects,
      writes,
      reject: () => {
        rejectSave = true;
      },
    };
  }

  it('rejects missing secret before body/context/model and fails closed when disabled', async () => {
    const { post, analyze, writes } = await setup();
    expect((await post(request, '')).status).toBe(403);
    expect((await post(request, 'wrong')).status).toBe(403);
    expect(analyze).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    const disabled = new Hono().route('/internal/news-analysis', createNewsAnalysisRoutes());
    expect(
      (await disabled.request('/internal/news-analysis', { method: 'POST', body: '{' })).status,
    ).toBe(503);
  });

  it('uses actual previous revision, keeps one effect, and skips replay after analyzer replacement', async () => {
    const state = await setup();
    expect((await state.post(request)).status).toBe(200);
    expect((await state.post({ ...request, newsVersionId: 'v2' })).status).toBe(200);
    expect(state.effects.size).toBe(1);
    expect(state.effects.get('tariff:lot-11')?.history).toHaveLength(2);
    expect(state.analyze.mock.calls[1]?.[0].previousEffects[0]?.currentRevision.revisionId).toBe(
      'revision-v1-tariff:lot-11',
    );
    expect(state.writes[1]).toMatchObject({
      drafts: [{ expectedPreviousRevisionId: 'revision-v1-tariff:lot-11' }],
    });
    const result = await state.makeAnalyzer().analyze({ ...request, newsVersionId: 'v2' });
    expect(result).toMatchObject({ duplicate: true, reasoningInvoked: false });
    expect(state.analyze).toHaveBeenCalledTimes(2);
    expect(state.effects.get('tariff:lot-11')?.history).toHaveLength(2);
    const historical = await state.makeAnalyzer().analyze(request);
    expect(historical.effects[0]?.currentRevision.newsVersionId).toBe('v1');
    expect(state.effects.get('tariff:lot-11')?.currentRevision.newsVersionId).toBe('v2');
    expect(state.analyze).toHaveBeenCalledTimes(2);
  });

  it('persists an empty completion, keeps absent old effects and never calls reasoning for its replay', async () => {
    const state = await setup();
    await state.post(request);
    state.analyze.mockImplementationOnce(async () => []);
    expect((await state.post({ ...request, newsVersionId: 'v3' })).status).toBe(200);
    expect(state.receipts.get('v3')?.effects).toEqual([]);
    expect(state.effects.size).toBe(1);
    expect(state.effects.get('tariff:lot-11')?.history).toHaveLength(1);
    await state.makeAnalyzer().analyze({ ...request, newsVersionId: 'v3' });
    expect(state.analyze).toHaveBeenCalledTimes(2);
  });

  it('lets the final review consolidate duplicate preliminary identities before any canonical write', async () => {
    const state = await setup();
    const review = vi.fn(async (_input: ReasoningInput, proposals: EffectDraft[]) => {
      expect(state.writes).toHaveLength(0);
      expect(proposals).toHaveLength(2);
      const first = proposals[0];
      if (!first) throw new Error('Missing preliminary fixture');
      return [
        { ...first, conclusion: 'Consolidated qualitative uncertainty across both mechanisms.' },
      ];
    });
    const analyzer = new NewsAnalyzer({
      ...state.analyzer.dependencies,
      reasoner: {
        analyze: async (input) => {
          const qualitative = { ...draft(input.context), calculation: undefined };
          return [
            qualitative,
            { ...qualitative, conclusion: 'A second qualitative aspect of the same company risk.' },
          ];
        },
        review,
      },
    });
    const result = await analyzer.analyze(request);
    expect(review).toHaveBeenCalledTimes(1);
    expect(result.effects).toHaveLength(1);
    expect(state.writes).toHaveLength(1);
  });

  it.each(['proposal', 'final'])(
    'rejects unsupported %s dependencies before prepare or save',
    async (phase) => {
      const state = await setup();
      const prepare = vi.spyOn(state.analyzer.dependencies.insights, 'prepare');
      const save = vi.spyOn(state.analyzer.dependencies.insights, 'saveAnalysis');
      const valid = { ...draft(bundle('v1')), calculation: undefined };
      const invalid: EffectDraft = {
        ...valid,
        status: 'unknown',
        assessment: {
          conditions: [
            {
              id: 'identity',
              assertion: 'observed',
              dependsOn: [],
              fact: 'Reference identity unconfirmed.',
              predicate: 'The indexes match.',
              status: 'unknown',
              sourceRefs: valid.sourceRefs,
            },
            {
              id: 'consequence',
              assertion: 'derived',
              dependsOn: ['identity'],
              fact: 'Contract formula requires matching index.',
              predicate: 'Expense increases.',
              status: 'supported',
              sourceRefs: valid.sourceRefs,
            },
          ],
          unknowns: [],
        },
      };
      const review = vi.fn(async () => [invalid]);
      const analyzer = new NewsAnalyzer({
        ...state.analyzer.dependencies,
        reasoner: { analyze: async () => [phase === 'proposal' ? invalid : valid], review },
      });
      await expect(analyzer.analyze(request)).rejects.toMatchObject({
        status: 422,
        code: 'UNSUPPORTED_EVIDENCE_DEPENDENCY',
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(state.writes).toHaveLength(0);
      expect(state.receipts.size).toBe(0);
    },
  );

  it('still rejects duplicate final identities without a canonical write', async () => {
    const state = await setup();
    const analyzer = new NewsAnalyzer({
      ...state.analyzer.dependencies,
      reasoner: {
        analyze: async (input) => {
          const qualitative = { ...draft(input.context), calculation: undefined };
          return [qualitative, qualitative];
        },
        review: async (_input, proposals) => proposals,
      },
    });
    await expect(analyzer.analyze(request)).rejects.toMatchObject({
      status: 422,
      code: 'DUPLICATE_BUSINESS_QUESTION',
    });
    expect(state.writes).toHaveLength(0);
  });

  it('propagates failed atomic persistence instead of returning empty success', async () => {
    const state = await setup();
    state.reject();
    const response = await state.post(request);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: 'INVALID_SOURCE',
      message: 'Source hash mismatch',
    });
    expect(state.effects.size).toBe(0);
    expect(state.receipts.size).toBe(0);
  });

  it('saves an empty receipt when canonical preparation leaves an existing head unrevised', async () => {
    const state = await setup();
    await state.analyzer.analyze(request);
    const previous = structuredClone([...state.effects.values()]);
    const prepare = vi
      .spyOn(state.analyzer.dependencies.insights, 'prepare')
      .mockResolvedValueOnce([]);

    const result = await state.analyzer.analyze({ ...request, newsVersionId: 'v2' });

    expect(prepare).toHaveBeenCalledOnce();
    expect(result.effects).toEqual([]);
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1]).toMatchObject({ drafts: [] });
    expect([...state.effects.values()]).toEqual(previous);
    expect(state.receipts.size).toBe(2);
  });

  it('coalesces concurrent identical commands within one process', async () => {
    const state = await setup();
    const results = await Promise.all([
      state.analyzer.analyze(request),
      state.analyzer.analyze(request),
    ]);
    expect(results.map((result) => result.reasoningInvoked)).toEqual([true, false]);
    expect(state.analyze).toHaveBeenCalledTimes(1);
    expect(state.writes).toHaveLength(1);
  });

  it('rejects changed receipt parameters and model source refs without persistence', async () => {
    const state = await setup();
    await state.post(request);
    expect((await state.post({ ...request, asOf: '2026-10-22T09:00:00Z' })).status).toBe(409);
    expect(state.analyze).toHaveBeenCalledTimes(1);
    state.analyze.mockImplementationOnce(async (input) => [
      {
        ...draft(input.context),
        sourceRefs: [
          { materialId: 'unseen-document', versionId: 'v1', contentHash: 'f'.repeat(64) },
        ],
      },
    ]);
    expect((await state.post({ ...request, newsVersionId: 'v2' })).status).toBe(422);
    expect(state.writes).toHaveLength(1);
  });

  it('requires context knowledge time to match exactly and rejects precision above 100ns', async () => {
    const state = await setup();
    const mismatch = await state.post({ ...request, asOf: '2026-10-22T08:00:00.0000001Z' });
    expect(mismatch.status).toBe(502);
    expect(await mismatch.json()).toMatchObject({ code: 'UPSTREAM_CONTRACT' });
    expect((await state.post({ ...request, asOf: '2026-10-22T08:00:00.00000001Z' })).status).toBe(
      400,
    );
    expect(state.analyze).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(0);
  });

  it('does not send a duplicate-key draft batch or silently rename an existing literal', async () => {
    const state = await setup();
    state.analyze.mockImplementationOnce(async (input) => [
      draft(input.context),
      draft(input.context),
    ]);
    expect((await state.post(request)).status).toBe(422);
    expect(state.writes).toHaveLength(0);
    await state.post(request);
    state.analyze.mockImplementationOnce(async (input) => [
      { ...draft(input.context), literalObjectRef: 'OTHER-LOT' },
    ]);
    expect((await state.post({ ...request, newsVersionId: 'v2' })).status).toBe(422);
    expect(state.writes).toHaveLength(1);
  });
});
