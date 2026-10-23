import { describe, expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { NewsFlow } from '../src/news-analysis/application/news-flow.ts';
import {
  analysisReceiptSchema,
  effectsResponseSchema,
  materialSchema,
} from '../src/news-analysis/contracts/analysis.ts';
import { NewsAnalysisError } from '../src/news-analysis/contracts/errors.ts';
import {
  type FlowReasoner,
  flowRequestSchema,
  type NewsJob,
  type RoleFact,
  type RoleProfile,
} from '../src/news-analysis/contracts/flow.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { FlowContextClient, FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const time = '2026-10-22T10:00:00Z';
const news = materialSchema.parse({
  materialId: 'news',
  versionId: '1',
  sourceId: 'synthetic',
  kind: 'news',
  title: 'Synthetic',
  text: 'Synthetic news',
  knownAt: time,
  companyIds: [],
  bankProfileIds: [],
  contentHash: 'a'.repeat(64),
});
const ref = {
  materialId: news.materialId,
  versionId: news.versionId,
  contentHash: news.contentHash,
};
function receipt(companyId: string) {
  return analysisReceiptSchema.parse({
    analysisId: `analysis-${companyId}`,
    companyId,
    newsMaterialId: 'news',
    newsVersionId: '1',
    asOf: time,
    completedAt: time,
    duplicate: false,
    resultSemantics: 'saved_analysis_revisions_not_latest_heads',
    effects: [
      {
        effectId: `effect-${companyId}`,
        revisionId: 'revision-1',
        previousRevisionId: null,
        duplicate: false,
        currentRevision: {
          revisionId: 'revision-1',
          previousRevisionId: null,
          newsVersionId: '1',
          asOf: time,
          createdAt: time,
          conclusion: 'Synthetic source-supported run-rate',
          status: 'forecast',
          sourceRefs: [ref],
          calculation: {
            expression: { kind: 'value', value: '-20000' },
            unit: 'RUB',
            period: '2026-11',
          },
          calculationResult: '-20000',
          impact: {
            metric: 'expense_delta',
            amountBasis: 'standard_month_run_rate',
            economicObjectId: null,
            evidenceStatus: 'supported',
            importance: 3,
            urgency: 2,
            novelty: 3,
          },
        },
      },
    ],
  });
}
const cfo: RoleProfile = {
  personId: 'cfo',
  companyId: a,
  revisionId: '1',
  role: 'Group CFO',
  responsibilities: ['Group budget'],
  allowedCompanyIds: [a, b],
  allowedMaterialIds: [],
  knownAt: time,
  sourceRefs: [ref],
};

function fixture(roles: RoleProfile[] = [cfo]) {
  const context = new FlowContextClient('http://context.test', 'test');
  const jobs = new FlowJobClient('http://insight.test', 'test');
  const analyzer = new NewsAnalyzer({
    context: new ContextClient('http://context.test', 'test'),
    insights: new InsightClient('http://insight.test', 'test'),
    reasoner: { analyze: async () => [] },
  });
  const request = flowRequestSchema.parse({
    newsMaterialId: 'news',
    newsVersionId: '1',
    asOf: time,
    groupIds: ['root'],
    personIds: roles.map((r) => r.personId),
    textCompleteness: 'full',
  });
  let job: NewsJob = {
    request: {
      jobId: 'synthetic-job',
      newsMaterialId: 'news',
      newsVersionId: '1',
      asOf: time,
      parameters: request,
    },
    status: 'running',
    version: 1,
    workerId: 'worker',
    leaseUntil: time,
    checkpoint: {},
    error: null,
    updatedAt: time,
  };
  vi.spyOn(context, 'material').mockResolvedValue(news);
  vi.spyOn(context, 'sync').mockResolvedValue({});
  vi.spyOn(context, 'changes').mockResolvedValue([]);
  vi.spyOn(context, 'search').mockResolvedValue({
    hits: [],
    mode: 'test',
    reranker: 'none',
    exhaustive: false,
    candidatesExamined: 0,
  });
  vi.spyOn(context, 'evidence').mockImplementation(async (companyId, asOf) => ({
    companyId,
    asOf,
    completeForLoadedScope: true,
    changeSequence: 0,
    watchAfterSequence: 0,
    sources: [
      {
        materialId: 'own-fixture',
        versionId: '1',
        contentHash: 'b'.repeat(64),
        sourceId: 'fixture-document',
        knownAt: time,
      },
    ],
  }));
  vi.spyOn(context, 'companies').mockResolvedValue([]);
  vi.spyOn(context, 'groups').mockResolvedValue([]);
  vi.spyOn(context, 'roles').mockResolvedValue(roles);
  vi.spyOn(context, 'expand').mockResolvedValue({
    groupId: 'root',
    companyIds: [a, b],
    paths: [
      { companyId: a, groupIds: ['root'] },
      { companyId: a, groupIds: ['root', 'nested'] },
      { companyId: b, groupIds: ['root', 'nested'] },
    ],
    missingGroups: [],
    cycles: [],
    complete: true,
    sourceRefs: [ref],
    aggregationRule: 'sum_compatible_owner_effects',
  });
  const claim = vi.spyOn(jobs, 'claim').mockImplementation(async () => job);
  vi.spyOn(jobs, 'update').mockImplementation(async (_old, checkpoint, status, error) => {
    job = {
      ...job,
      checkpoint: structuredClone(checkpoint),
      status: status ?? 'running',
      error: error ?? null,
      version: job.version + 1,
    };
    return job;
  });
  const analyze = vi.spyOn(analyzer, 'analyze').mockImplementation(async (input) => ({
    ...receipt(input.companyId),
    reasoningInvoked: true,
    contextComplete: true,
  }));
  vi.spyOn(analyzer, 'recipients').mockResolvedValue({ companyIds: [], nextCursor: null });
  vi.spyOn(analyzer, 'currentEffects').mockResolvedValue([]);
  const reasoner: FlowReasoner = {
    plan: vi.fn(async () => ({
      eventSummary: 'Synthetic',
      queries: ['Synthetic query'],
      generalInsights: [],
    })),
    role: vi.fn(async (_profile, facts: RoleFact[]) => ({
      actions: [
        {
          action: 'Review budget',
          rationale: 'Source-supported change',
          effectIds: facts.slice(0, 1).map((fact) => fact.effectId),
          priority: 3,
        },
      ],
      missingContext: [],
    })),
  };
  const flow = new NewsFlow({ context, jobs, analyzer, reasoner });
  return {
    flow,
    context,
    jobs,
    analyze,
    analyzer,
    reasoner,
    claim,
    job: () => job,
    restart: () => new NewsFlow({ context, jobs, analyzer, reasoner }),
  };
}

describe('durable news flow projections', () => {
  it('keeps profile-only companies at applicability without model company passes', async () => {
    const f = fixture([]);
    vi.mocked(f.context.evidence).mockImplementation(async (companyId, asOf) => ({
      companyId,
      asOf,
      completeForLoadedScope: true,
      changeSequence: 0,
      watchAfterSequence: 0,
      sources: [{ ...ref, sourceId: 'provided-bank-csv', knownAt: time }],
    }));
    const shallow = vi
      .spyOn(f.analyzer, 'recordApplicability')
      .mockImplementation(async (input) => ({
        ...receipt(input.companyId),
        effects: [],
        reasoningInvoked: false,
        contextComplete: false,
      }));
    await f.flow.tick();
    expect(f.analyze).not.toHaveBeenCalled();
    expect(shallow).toHaveBeenCalledTimes(2);
    expect(f.job().checkpoint.companies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          companyId: a,
          depth: expect.objectContaining({
            level: 'applicability',
            reason: 'profile_only',
            applicability: 'unknown',
          }),
        }),
      ]),
    );
    expect(f.job().status).toBe('completed');
    expect(f.job().checkpoint.result).toMatchObject({
      groups: [{ complete: false, totals: [] }],
      rankedCompanyFacts: [],
      coverage: { completeForSelectedScopes: false },
    });
  });

  it.each(['material:company', 'after-inventory', 'role', 'foreign-market'])(
    'catches up a late %s after the global pump has already observed it',
    async (category) => {
      const f = fixture([]);
      vi.spyOn(f.flow, 'start').mockImplementation(() => {});
      f.job().request.parameters = {
        ...flowRequestSchema.parse(f.job().request.parameters),
        targetCompanyIds: [a],
      };
      vi.mocked(f.context.evidence).mockImplementation(async (companyId, asOf) => ({
        companyId,
        asOf,
        changeSequence: category === 'after-inventory' ? 0 : 1,
        watchAfterSequence: 0,
        completeForLoadedScope: true,
        sources: [{ ...ref, sourceId: 'provided-bank-csv', knownAt: time }],
      }));
      let arrived = category !== 'after-inventory';
      vi.spyOn(f.analyzer, 'recordApplicability').mockImplementation(async (input) => {
        arrived = true; // The global source pump may already have advanced past this event.
        return {
          ...receipt(input.companyId),
          effects: [],
          reasoningInvoked: false,
          contextComplete: false,
        };
      });
      const later = '2026-10-22T11:00:00Z';
      vi.mocked(f.context.changes).mockImplementation(async (after) =>
        arrived && after === 0
          ? [
              {
                sequence: 1,
                category:
                  category === 'foreign-market'
                    ? 'material:market'
                    : category === 'after-inventory'
                      ? 'material:company'
                      : category,
                entityId: 'first-own',
                versionId: '1',
                knownAt: later,
                companyIds: category === 'foreign-market' ? [b] : [a],
              },
            ]
          : [],
      );
      const create = vi.spyOn(f.jobs, 'create').mockImplementation(async (jobId, parameters) => ({
        ...f.job(),
        request: { ...f.job().request, jobId, parameters },
      }));
      await f.flow.tick();
      expect(f.analyze).not.toHaveBeenCalled();
      if (category === 'foreign-market') expect(create).not.toHaveBeenCalled();
      else
        expect(create).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            targetCompanyIds: [a],
            asOf: later,
            ...(category === 'role'
              ? { projectionOnly: true }
              : { trigger: { materialId: 'first-own', versionId: '1' } }),
          }),
        );
      expect(f.job().checkpoint.watchCursors).toEqual([
        expect.objectContaining({ companyId: a, afterSequence: 1, complete: true }),
      ]);
    },
  );

  it('reuses the first observation when another consumer wins the material insert race', async () => {
    const f = fixture([]);
    vi.spyOn(f.flow, 'start').mockImplementation(() => {});
    vi.spyOn(f.jobs, 'create').mockResolvedValue(f.job());
    const event = {
      source: 'tass',
      externalId: 'race',
      title: 'Title only',
      text: '',
      publishedAt: time,
    };
    vi.mocked(f.context.material).mockImplementationOnce(async () => {
      throw new NewsAnalysisError(404, 'material_not_found', 'Missing');
    });
    vi.mocked(f.context.material).mockImplementation(async (id, version) =>
      materialSchema.parse({
        ...news,
        materialId: id,
        versionId: version,
        sourceId: 'tass',
        title: event.title,
        text: '',
        knownAt: time,
        publishedAt: time,
        provenance: {
          acquisition: 'event_payload',
          sourceUrl: null,
          retrievedAt: time,
          textCompleteness: 'lead',
          originVersionId: null,
          locator: 'race',
        },
      }),
    );
    vi.spyOn(f.context, 'saveMaterial').mockRejectedValue(
      new NewsAnalysisError(409, 'immutable_version_conflict', 'Concurrent insertion'),
    );
    await f.flow.ingest(event);
    expect(f.jobs.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ asOf: time, textCompleteness: 'lead' }),
    );
  });
  it('retains event acquisition provenance and cannot upgrade a saved lead during replay', async () => {
    const f = fixture([]);
    vi.spyOn(f.flow, 'start').mockImplementation(() => {});
    vi.spyOn(f.jobs, 'create').mockResolvedValue(f.job());
    vi.mocked(f.context.material).mockRejectedValueOnce(
      new NewsAnalysisError(404, 'material_not_found', 'Not found'),
    );
    let stored: typeof news | undefined;
    const save = vi.spyOn(f.context, 'saveMaterial').mockImplementation(async (value) => {
      const payload = materialSchema.omit({ contentHash: true }).parse(value);
      stored = materialSchema.parse({ ...payload, contentHash: 'b'.repeat(64) });
      return stored;
    });
    const event = {
      source: 'tass',
      externalId: '123',
      title: 'Fixture lead',
      text: 'Only a lead',
      publishedAt: time,
      knownAt: time,
      textCompleteness: 'lead',
      sourceUrl: 'https://tass.ru/ekonomika/123',
    };
    await f.flow.ingest(event);
    expect(stored?.provenance).toEqual({
      acquisition: 'event_payload',
      sourceUrl: event.sourceUrl,
      retrievedAt: time,
      textCompleteness: 'lead',
      originVersionId: null,
      locator: '123',
    });
    if (!stored) throw new Error('Missing stored fixture');
    vi.mocked(f.context.material).mockResolvedValue(stored);
    await f.flow.ingest({ ...event, knownAt: '2026-10-23T10:00:00Z', textCompleteness: 'full' });
    expect(save).toHaveBeenCalledOnce();
    expect(vi.mocked(f.jobs.create).mock.calls[1]).toEqual(vi.mocked(f.jobs.create).mock.calls[0]);
    expect(vi.mocked(f.jobs.create).mock.calls[1]?.[1].textCompleteness).toBe('lead');
  });
  it('includes previous question recipients even when fresh search returns nothing', async () => {
    const f = fixture([]);
    f.job().request.parameters = {
      ...flowRequestSchema.parse(f.job().request.parameters),
      groupIds: [],
    };
    vi.mocked(f.analyzer.recipients).mockResolvedValue({ companyIds: [a], nextCursor: null });
    await f.flow.tick();
    expect(f.analyze.mock.calls.map((c) => c[0].companyId)).toEqual([a]);
  });

  it('projects prior independent-news state and withholds invalidated premises from role actions', async () => {
    const f = fixture();
    const old = receipt(a).effects[0];
    if (!old) throw new Error('Missing synthetic fixture');
    vi.mocked(f.analyzer.currentEffects).mockImplementation(async (input) =>
      input.companyId === a
        ? effectsResponseSchema.parse({
            effects: [
              {
                effectId: 'prior-question',
                effectKey: 'prior-financing',
                companyId: a,
                newsMaterialId: 'independent-old-news',
                literalObjectRef: `company:${a}`,
                requiresReassessment: true,
                currentRevision: { ...old.currentRevision, calculationResult: '-7000' },
                history: [{ ...old.currentRevision, calculationResult: '-7000' }],
              },
            ],
          }).effects
        : [],
    );
    await f.flow.tick();
    expect(f.job().checkpoint.result).toMatchObject({
      coverage: { staleEffectIds: ['prior-question'], completeForSelectedScopes: false },
      groups: [{ complete: false, coverage: { unrevisedEffectIds: ['prior-question'] } }],
    });
    const facts = vi.mocked(f.reasoner.role).mock.calls[0]?.[1] ?? [];
    expect(facts.some((x) => x.effectId === 'prior-question')).toBe(false);
  });

  it('refreshes membership totals from common state without new company analysis', async () => {
    const f = fixture([]);
    vi.spyOn(f.analyzer, 'readCompany').mockImplementation(async (input) => ({
      ...receipt(input.companyId),
      reasoningInvoked: false,
      contextComplete: true,
    }));
    f.job().request.parameters = {
      ...flowRequestSchema.parse(f.job().request.parameters),
      projectionOnly: true,
      targetCompanyIds: [a],
    };
    await f.flow.tick();
    expect(f.job().checkpoint.result).toMatchObject({
      groups: [{ totals: [{ fullTotal: '-40000' }] }],
    });
    f.job().checkpoint = {};
    vi.mocked(f.context.expand).mockResolvedValue({
      groupId: 'root',
      companyIds: [a],
      paths: [{ companyId: a, groupIds: ['root'] }],
      missingGroups: [],
      cycles: [],
      complete: true,
      sourceRefs: [ref],
      aggregationRule: 'sum_compatible_owner_effects',
    });
    await f.flow.tick();
    expect(f.job().checkpoint.result).toMatchObject({
      groups: [{ totals: [{ fullTotal: '-20000' }] }],
    });
    expect(f.analyze).not.toHaveBeenCalled();
  });
  it('checkpoints a bounded batch as partial and resumes remaining recipients after restart', async () => {
    const f = fixture([]);
    f.job().request.parameters = {
      ...flowRequestSchema.parse(f.job().request.parameters),
      companyBudget: 1,
    };
    await f.flow.tick();
    expect(f.job().status).toBe('partial');
    expect(f.analyze.mock.calls.map((c) => c[0].companyId)).toEqual([a]);
    expect(f.job().checkpoint.pendingCompanyIds).toEqual([b]);
    await f.restart().tick();
    expect(f.job().status).toBe('completed');
    expect(f.analyze.mock.calls.map((c) => c[0].companyId)).toEqual([a, b]);
    expect(f.job().checkpoint.pendingCompanyIds).toEqual([]);
    expect(f.reasoner.plan).toHaveBeenCalledTimes(1);
  });
  it('retries failed company work while retaining successful receipts and the saved plan', async () => {
    const f = fixture();
    f.analyze.mockRejectedValueOnce(new NewsAnalysisError(503, 'TEMPORARY', 'Synthetic outage'));
    await f.flow.tick();
    expect(f.job().status).toBe('failed');
    expect(f.job().error).toBe('PARTIAL_ANALYSIS_FAILED');
    f.job().status = 'running'; // The actual store admits this only via its explicit retry endpoint.
    await f.flow.tick();
    expect(f.job().status).toBe('completed');
    expect(f.analyze.mock.calls.map((call) => call[0].companyId)).toEqual([a, b, a]);
    expect(f.reasoner.plan).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.reasoner.role).mock.calls.at(-1)?.[2]?.[0]?.complete).toBe(true);
  });

  it('selects the explicit role grant even when discovery returns no candidates', async () => {
    const f = fixture();
    const parameters = flowRequestSchema.parse(f.job().request.parameters);
    f.job().request.parameters = { ...parameters, groupIds: [] };
    await f.flow.tick();
    expect(f.analyze.mock.calls.map((call) => call[0].companyId)).toEqual([a, b]);
    expect(f.job().checkpoint.result).toMatchObject({
      coverage: { completeForSelectedScopes: true },
    });
  });

  it('reports an unknown explicitly requested person instead of a vacuous complete role scope', async () => {
    const f = fixture([]);
    const parameters = flowRequestSchema.parse(f.job().request.parameters);
    f.job().request.parameters = { ...parameters, personIds: ['missing'] };
    await f.flow.tick();
    expect(f.job().checkpoint.result).toMatchObject({
      coverage: { completeForSelectedScopes: false, missingPersonIds: ['missing'] },
    });
  });

  it('passes an authorized nested group to the CFO and withholds it from a company-only role', async () => {
    const f = fixture([
      cfo,
      { ...cfo, personId: 'treasurer', companyId: b, allowedCompanyIds: [b] },
    ]);
    await f.flow.tick();
    expect(f.job().status).toBe('completed');
    const calls = vi.mocked(f.reasoner.role).mock.calls;
    expect(calls[0]?.[2]).toMatchObject([
      { groupId: 'root', companyIds: [a, b], complete: true, totals: [{ fullTotal: '-40000' }] },
    ]);
    expect(calls[1]?.[1].map((fact) => fact.companyId)).toEqual([b]);
    expect(calls[1]?.[2]).toEqual([]);
    expect(f.analyze).toHaveBeenCalledTimes(2);
  });

  it('withholds group metadata when a member fact cites an ungranted material', async () => {
    const f = fixture();
    f.analyze.mockImplementation(async (input) => {
      const saved = receipt(input.companyId);
      const effect = saved.effects[0];
      if (!effect) throw new Error('Missing fixture effect');
      if (input.companyId === b) {
        effect.currentRevision.sourceRefs = [{ ...ref, materialId: 'private' }];
        effect.currentRevision.calculation = null;
        effect.currentRevision.calculationResult = null;
        if (effect.currentRevision.impact) effect.currentRevision.impact.evidenceStatus = 'unknown';
      }
      return { ...saved, reasoningInvoked: true, contextComplete: true };
    });
    vi.mocked(f.context.material).mockImplementation(async (id) =>
      id === 'private'
        ? { ...news, materialId: 'private', kind: 'company', companyIds: [b] }
        : news,
    );
    await f.flow.tick();
    const call = vi.mocked(f.reasoner.role).mock.calls[0];
    expect(call?.[1].map((fact) => fact.companyId)).toEqual([a]);
    expect(call?.[2]).toEqual([]);
  });
});
