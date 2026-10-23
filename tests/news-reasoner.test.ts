import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setProvider } from '@flue/runtime';
import { type Flue, start } from '@flue/runtime/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CompanyConsequencesAgent,
  EvidenceRelevanceAgent,
  NewsPlannerAgent,
  RoleProjectionAgent,
  SegmentPlannerAgent,
  SegmentReviewAgent,
  SourceSignalsAgent,
  SourceSignalsReviewAgent,
} from '../src/agents/news-analysis.ts';
import { createModelProvider } from '../src/config/model.ts';
import {
  contextBundleSchema,
  effectsResponseSchema,
  type ReasoningInput,
} from '../src/news-analysis/contracts/analysis.ts';
import type { NewsPlan } from '../src/news-analysis/contracts/flow.ts';
import { runNewsAgent } from '../src/news-analysis/reasoning/agent-runner.ts';
import { createNativeNewsReasoner } from '../src/news-analysis/reasoning/company-reasoner.ts';
import { createFlowReasoner } from '../src/news-analysis/reasoning/flow-reasoner.ts';
import { extractInventories } from '../src/news-analysis/reasoning/source-signals.ts';
import type { SourceUnit } from '../src/news-analysis/retrieval/source-units.ts';
import { sourceUnits } from '../src/news-analysis/retrieval/source-units.ts';
import { createHttpService } from './helpers/http-service.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const time = '2026-10-22T08:00:00Z';
const context = contextBundleSchema.parse({
  news: {
    materialId: 'synthetic-news',
    versionId: 'v1',
    sourceId: 'source-1',
    kind: 'news',
    title: 'Synthetic news',
    text: 'Synthetic future tariff change, not an incurred expense. Договор SYNTHETIC-LOT.',
    knownAt: time,
    companyIds: [],
    bankProfileIds: [],
    contentHash: 'a'.repeat(64),
  },
  materials: [],
  coverage: {
    complete: true,
    materialCount: 0,
    companyMaterialCount: 0,
    marketMaterialCount: 0,
    previousNewsVersionCount: 0,
    characters: 100,
    asOf: time,
  },
});
const input = {
  request: { companyId, newsMaterialId: 'synthetic-news', newsVersionId: 'v1', asOf: time },
  context,
  previousEffects: [],
};

function segmentInput(plan: NewsPlan, units: SourceUnit[]) {
  return {
    ...plan,
    generalInsights: plan.generalInsights.map(({ sourceRefs, ...i }, index) => ({
      ...i,
      sourceUnitIds: units
        .filter((u) =>
          sourceRefs.some(
            (r) => r.materialId === u.sourceRef.materialId && r.versionId === u.sourceRef.versionId,
          ),
        )
        .map((u) => u.unitId),
      segmentKeys: (plan.segmentCoverage ?? [])
        .filter((r) => r.insightIndexes.includes(index))
        .map((r) => r.segmentKey),
    })),
    segmentCoverage: (plan.segmentCoverage ?? []).map(({ insightIndexes: _indexes, ...r }) => r),
    sourceCoverage: (plan.sourceCoverage ?? []).map(({ insightIndexes: _indexes, ...r }) => ({
      ...r,
      signals: r.signals ?? [],
    })),
  };
}

describe('Flue news agents with the project provider over HTTP', () => {
  const servers: Awaited<ReturnType<typeof createHttpService>>[] = [];
  let runtime: Flue;
  beforeEach(async () => {
    runtime = await start({
      agents: [
        CompanyConsequencesAgent,
        NewsPlannerAgent,
        SourceSignalsAgent,
        SourceSignalsReviewAgent,
        EvidenceRelevanceAgent,
        SegmentPlannerAgent,
        SegmentReviewAgent,
        RoleProjectionAgent,
      ],
      providers: [],
    });
  });
  afterEach(async () => {
    await runtime.stop();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    vi.unstubAllEnvs();
  });

  async function adapter(
    toolResult: unknown,
    toolResponse = true,
    toolName = 'submit_news_analysis',
    recoveredToolResult?: unknown,
  ) {
    const requests: unknown[] = [];
    const server = await createHttpService(async (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer native-test-key');
      expect(request.headers.has('X-Internal-Secret')).toBe(false);
      const payload: unknown = await request.json();
      requests.push(payload);
      const args = JSON.stringify(requests.length === 2 ? recoveredToolResult : toolResult);
      const sendsTool =
        toolResponse &&
        (requests.length === 1 || (requests.length === 2 && recoveredToolResult !== undefined));
      const delta = sendsTool
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${requests.length}`,
                type: 'function',
                function: { name: toolName, arguments: args },
              },
            ],
          }
        : { content: 'Unstructured unsupported answer' };
      const chunk = (value: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: 'completion-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, delta: value, finish_reason: finish }],
        })}\n\n`;
      return new Response(
        chunk({ role: 'assistant' }, null) +
          chunk(delta, null) +
          chunk({}, sendsTool ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        {
          headers: { 'Content-Type': 'text/event-stream' },
        },
      );
    });
    servers.push(server);
    setProvider(
      createModelProvider({
        LLM_BASE_URL: `${server.url}/v1`,
        LLM_API_KEY: 'native-test-key',
        LLM_MODEL: 'test-model',
        LLM_CONTEXT_WINDOW: '128000',
        LLM_MAX_TOKENS: '8192',
        LLM_REASONING: 'false',
      }),
    );
    const reasoner = createNativeNewsReasoner();
    return { reasoner, requests };
  }

  type Call = { name: string; arguments: unknown };
  async function toolSequence(calls: (Call | Call[] | { text: string })[]) {
    const requests: unknown[] = [];
    const server = await createHttpService(async (request) => {
      requests.push(await request.json());
      const call = calls[requests.length - 1];
      if (!call) return new Response('Unexpected model turn', { status: 400 });
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `turn-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      const batch = Array.isArray(call) ? call : 'text' in call ? [] : [call];
      const delta =
        'text' in call
          ? { role: 'assistant', content: call.text }
          : {
              role: 'assistant',
              tool_calls: batch.map((item, index) => ({
                index,
                id: `call-${requests.length}-${index}`,
                type: 'function',
                function: { name: item.name, arguments: JSON.stringify(item.arguments) },
              })),
            };
      return new Response(
        `${chunk(delta, null) + chunk({}, batch.length ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    servers.push(server);
    setProvider(
      createModelProvider({
        LLM_BASE_URL: `${server.url}/v1`,
        LLM_API_KEY: 'native-test-key',
        LLM_MODEL: 'test-model',
        LLM_REASONING: 'false',
      }),
    );
    return requests;
  }

  it.each(['analyze', 'review'] as const)(
    'lets the company agent %s retrieve a missing original, read its new handle and cite the exact version',
    async (phase) => {
      const original = {
        ...context.news,
        materialId: 'synthetic-terms',
        versionId: '2',
        kind: 'company',
        companyIds: [companyId],
        text: 'Договор SYN-TERMS: индивидуальная формула ещё не подтверждена.',
        contentHash: 'b'.repeat(64),
      };
      const captured: unknown[] = [];
      const service = await createHttpService(async (request) => {
        expect(request.headers.get('X-Internal-Secret')).toBe('test-internal-secret');
        if (new URL(request.url).pathname.endsWith('/internal/context/retrieve')) {
          captured.push(await request.json());
          return Response.json({
            ...context,
            materials: [original],
            coverage: { ...context.coverage, materialCount: 2 },
          });
        }
        return Response.json(original);
      });
      servers.push(service);
      vi.stubEnv('CONTEXT_SERVICE_URL', service.url);
      vi.stubEnv('INTERNAL_SECRET', 'test-internal-secret');
      const calls = await toolSequence([
        {
          name: 'context_find_company_facts',
          arguments: {
            missingFact: 'Договорная формула',
            query: 'SYN-TERMS формула',
            scope: 'company',
            materialId: 'synthetic-terms',
          },
        },
        { name: 'context_read_original', arguments: { sourceHandle: 's1' } },
        {
          name: 'submit_news_analysis',
          arguments: {
            drafts: [
              {
                objectHandle: 'o2',
                question: {
                  mechanism: 'financing_cost',
                  frame: 'absolute',
                  unit: 'qualitative',
                  targetPeriod: '2026-11',
                  baselinePeriod: null,
                  basis: 'unknown',
                },
                assessment: {
                  conditions: [
                    {
                      fact: 'Формула не подтверждена',
                      predicate: 'Формула установлена договором',
                      status: 'unknown',
                      sourceHandles: ['s1'],
                    },
                  ],
                  unknowns: [
                    {
                      fact: 'Неизвестна формула',
                      query: null,
                      scope: 'company',
                      materialId: 'synthetic-terms',
                    },
                  ],
                },
                conclusion: 'Денежный эффект неизвестен.',
                status: 'unknown',
                impact: {
                  metric: 'risk',
                  amountBasis: 'qualitative',
                  economicObjectId: null,
                  evidenceStatus: 'unknown',
                  importance: 2,
                  urgency: 1,
                  novelty: 1,
                },
                sourceHandles: ['s0', 's1'],
                calculation: null,
              },
            ],
          },
        },
      ]);
      const freshInput: ReasoningInput = structuredClone(input);
      freshInput.context.coverage.complete = false;
      const reasoner = createNativeNewsReasoner();
      expect(reasoner.retrievalMode).toBe('agent_tools');
      if (!reasoner.review) throw new Error('Missing final review');
      const drafts =
        phase === 'analyze'
          ? await reasoner.analyze(freshInput)
          : await reasoner.review(freshInput, [], {});
      expect(freshInput.toolTrace).toEqual([
        expect.objectContaining({ queries: ['SYN-TERMS формула'], stopReason: 'new_evidence' }),
      ]);
      expect(drafts[0]?.literalObjectRef).toBe('SYN-TERMS');
      expect(drafts[0]?.sourceRefs).toContainEqual({
        materialId: 'synthetic-terms',
        versionId: '2',
        contentHash: 'b'.repeat(64),
      });
      expect(freshInput.context.materials).toContainEqual(original);
      expect(captured).toEqual([
        {
          companyId,
          newsMaterialId: 'synthetic-news',
          newsVersionId: 'v1',
          asOf: time,
          queries: ['SYN-TERMS формула'],
          limit: 12,
          scope: 'company',
          requiredMaterialIds: ['synthetic-terms'],
        },
      ]);
      expect(calls).toHaveLength(3);
      expect(JSON.stringify(calls)).not.toContain('test-internal-secret');
    },
  );

  it('runs a real Flue external-search tool call through the verified news-service HTTP contract', async () => {
    const requests: string[] = [];
    const service = await createHttpService(async (request) => {
      requests.push(request.url);
      expect(request.headers.get('X-Internal-Secret')).toBe('test-internal-secret');
      return Response.json([
        {
          externalId: '123',
          title: 'Rate decision',
          lead: 'Lead only',
          url: 'https://tass.ru/ekonomika/123',
          publishedAt: '2026-10-21T10:00:00Z',
        },
      ]);
    });
    servers.push(service);
    vi.stubEnv('CONTEXT_SERVICE_URL', service.url);
    vi.stubEnv('NEWS_SERVICE_URL', service.url);
    vi.stubEnv('INTERNAL_SECRET', 'test-internal-secret');
    const plan = {
      eventSummary: 'Decision; exact original unavailable',
      queries: ['ставка'],
      generalInsights: [],
    };
    const calls = await toolSequence([
      {
        name: 'news_search_external_publications',
        arguments: { query: 'ключевая ставка', channel: 'tass' },
      },
      { name: 'plan_news_insights', arguments: plan },
    ]);
    expect(await createFlowReasoner().plan(context.news, [], 'lead', { asOf: time })).toEqual(plan);
    expect(new URL(requests[0] ?? '').pathname).toBe('/internal/news/tass-search');
    expect(new URL(requests[0] ?? '').searchParams.get('search')).toBe('ключевая ставка');
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toContain('https://tass.ru/ekonomika/123');
    expect(JSON.stringify(calls[1])).toContain('originVersion');
    expect(JSON.stringify(calls[1])).toContain('lead_observations');
  });

  it('persists no-new-evidence after a repeated company query and prevents another HTTP search', async () => {
    let searches = 0;
    const original = {
      ...context.news,
      materialId: 'synthetic-extra',
      contentHash: 'b'.repeat(64),
    };
    const service = await createHttpService(async () => {
      searches++;
      return Response.json({ ...context, materials: [original] });
    });
    servers.push(service);
    vi.stubEnv('CONTEXT_SERVICE_URL', service.url);
    vi.stubEnv('INTERNAL_SECRET', 'test-internal-secret');
    const query = {
      missingFact: 'Missing term',
      query: 'one query',
      scope: 'company',
      materialId: null,
    };
    const calls = await toolSequence([
      { name: 'context_find_company_facts', arguments: query },
      { name: 'context_find_company_facts', arguments: query },
      { name: 'context_find_company_facts', arguments: { ...query, query: 'different query' } },
      { name: 'submit_news_analysis', arguments: { drafts: [] } },
    ]);
    expect(await createNativeNewsReasoner().analyze(structuredClone(input))).toEqual([]);
    expect(searches).toBe(1);
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls[3])).toContain('no_new_evidence');
  });

  it('rejects a final result sent in the same model turn as evidence retrieval', async () => {
    const service = await createHttpService(async () => Response.json(context.news));
    servers.push(service);
    vi.stubEnv('CONTEXT_SERVICE_URL', service.url);
    vi.stubEnv('INTERNAL_SECRET', 'test-internal-secret');
    const calls = await toolSequence([
      [
        { name: 'context_read_original', arguments: { sourceHandle: 's0' } },
        { name: 'submit_news_analysis', arguments: { drafts: [] } },
      ],
      { text: 'Done' },
    ]);
    await expect(createNativeNewsReasoner().analyze(structuredClone(input))).rejects.toMatchObject({
      code: 'INVALID_REASONING_RESULT',
    });
    expect(calls).toHaveLength(2);
  });

  it('allows a later standalone result after a mixed invalid argument attempt', async () => {
    const service = await createHttpService(async () => Response.json(context.news));
    servers.push(service);
    vi.stubEnv('CONTEXT_SERVICE_URL', service.url);
    vi.stubEnv('INTERNAL_SECRET', 'test-internal-secret');
    await toolSequence([
      [
        { name: 'context_read_original', arguments: { sourceHandle: 's0' } },
        { name: 'submit_news_analysis', arguments: { drafts: [{ invalid: true }] } },
      ],
      { name: 'submit_news_analysis', arguments: { drafts: [] } },
    ]);
    expect(await createNativeNewsReasoner().analyze(structuredClone(input))).toEqual([]);
  });

  it('runs a terminating Flue result tool once and preserves source-bound decimal ASTs', async () => {
    const draft = {
      effectKey: 'synthetic-effect',
      literalObjectRef: 'SYNTHETIC-LOT',
      conclusion: 'Synthetic forecast only.',
      status: 'forecast',
      sourceRefs: [{ materialId: 'synthetic-news', versionId: 'v1', contentHash: 'a'.repeat(64) }],
      calculation: {
        expression: {
          kind: 'multiply',
          left: { kind: 'value', value: '150' },
          right: { kind: 'value', value: '104' },
        },
        unit: 'RUB',
        period: 'Synthetic future period',
      },
    };
    const { reasoner, requests } = await adapter({
      drafts: [
        {
          objectHandle: 'o1',
          assessment: { conditions: [], unknowns: [] },
          question: {
            mechanism: 'input_cost',
            frame: 'absolute',
            unit: 'RUB',
            targetPeriod: '2026',
            baselinePeriod: null,
            basis: 'contract_total',
          },
          status: 'forecast',
          conclusion: draft.conclusion,
          impact: {
            metric: 'expense_delta',
            amountBasis: 'contract_total',
            economicObjectId: null,
            evidenceStatus: 'supported',
            importance: 3,
            urgency: 2,
            novelty: 3,
          },
          sourceHandles: ['s0'],
          calculation: { expression: '150 * 104', unit: 'RUB', period: 'Synthetic future period' },
        },
      ],
    });
    expect(await reasoner.analyze(input)).toMatchObject([
      {
        literalObjectRef: 'SYNTHETIC-LOT',
        effectKey: 'draft-0',
        sourceRefs: draft.sourceRefs,
        calculation: draft.calculation,
      },
    ]);
    expect(requests).toHaveLength(1);
    const request = z
      .object({
        stream: z.literal(true),
        tools: z.array(
          z.object({
            function: z.object({
              name: z.string(),
              parameters: z.object({ type: z.literal('object') }),
            }),
          }),
        ),
        messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
      })
      .parse(requests[0]);
    expect(request.tools.some((tool) => tool.function.name === 'submit_news_analysis')).toBe(true);
    expect(
      request.tools.find((tool) => tool.function.name === 'submit_news_analysis')?.function
        .parameters.type,
    ).toBe('object');
    expect(JSON.stringify(request.messages)).toContain('synthetic-news');
    expect(JSON.stringify(request.messages)).not.toContain('native-test-key');
  });

  it('rejects plain text and malformed tool results without fabricating drafts', async () => {
    const plain = await adapter({ drafts: [] }, false);
    await expect(plain.reasoner.analyze(input)).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_REASONING_RESULT',
    });
    expect(plain.requests).toHaveLength(1);
    const malformed = await adapter({ drafts: [{ effectKey: 'incomplete' }] });
    await expect(malformed.reasoner.analyze(input)).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_REASONING_RESULT',
    });
    // Flue reports invalid tool arguments to the model; the following plain-text
    // stop still fails the result contract and cannot become a domain draft.
    expect(malformed.requests).toHaveLength(2);
  });

  it('binds an existing question to a cited new original version without requiring the old version', async () => {
    const question = {
      mechanism: 'financing_cost' as const,
      frame: 'absolute' as const,
      unit: 'RUB',
      targetPeriod: '2026-11',
      baselinePeriod: null,
      basis: 'monthly_run_rate' as const,
    };
    const revision = {
      revisionId: 'history-revision-must-not-enter-model',
      previousRevisionId: null,
      newsVersionId: 'old',
      asOf: time,
      conclusion: 'Old source assessment',
      status: 'unknown',
      sourceRefs: [],
      createdAt: time,
      impact: null,
      question,
    };
    const previous = effectsResponseSchema.parse({
      effects: [
        {
          effectId: 'canonical-id-must-not-enter-model',
          effectKey: 'draft-0',
          companyId,
          newsMaterialId: 'independent-news',
          literalObjectRef: 'SYNTHETIC-LOT',
          currentRevision: revision,
          history: [revision],
        },
      ],
    }).effects;
    const old = {
      ...context.news,
      kind: 'company' as const,
      materialId: 'synthetic-agreement',
      text: 'Договор SYNTHETIC-LOT. Old terms.',
      companyIds: [companyId],
    };
    const updated = { ...old, versionId: 'updated', text: 'Договор SYNTHETIC-LOT. Revised terms.' };
    const revisedContext = {
      ...context,
      news: { ...context.news, text: 'Synthetic rate observation' },
      materials: [old, updated],
    };
    const { reasoner, requests } = await adapter({
      drafts: [
        {
          objectHandle: 'o1',
          question: 'q0',
          conclusion: 'Revised original supports this condition.',
          status: 'unknown',
          assessment: {
            conditions: [
              {
                fact: 'Revised condition',
                predicate: 'Original revised',
                status: 'supported',
                sourceHandles: ['s2'],
              },
            ],
            unknowns: [],
          },
          sourceHandles: ['s0', 's2'],
          impact: {
            metric: 'risk',
            amountBasis: 'qualitative',
            economicObjectId: null,
            evidenceStatus: 'unknown',
            importance: 2,
            urgency: 2,
            novelty: 2,
          },
        },
      ],
    });
    const result = await reasoner.analyze({
      ...input,
      context: revisedContext,
      previousEffects: previous,
    });
    expect(result[0]?.question).toEqual(question);
    expect(result[0]?.effectKey).toBe('draft-0');
    expect(result[0]?.sourceRefs.some((s) => s.versionId === 'updated')).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('history-revision-must-not-enter-model');
    expect(JSON.stringify(requests)).not.toContain('canonical-id-must-not-enter-model');
  });

  it('accepts one successful result after Flue reports invalid arguments to the model', async () => {
    const recovered = await adapter(
      { drafts: [{ objectHandle: 'unknown' }] },
      true,
      'submit_news_analysis',
      { drafts: [] },
    );
    expect(await recovered.reasoner.analyze(input)).toEqual([]);
    expect(recovered.requests).toHaveLength(2);
  });

  it('keeps financing and rent-indexation unknowns as separate stable questions', async () => {
    const risk = {
      objectHandle: 'o0',
      assessment: { conditions: [], unknowns: [] },
      question: {
        mechanism: 'financing_cost',
        frame: 'absolute',
        unit: 'RUB',
        targetPeriod: '2026',
        baselinePeriod: null,
        basis: 'contract_total',
      },
      status: 'observed',
      conclusion: 'Financing exposure is unknown.',
      sourceHandles: ['s0'],
      impact: {
        metric: 'risk',
        amountBasis: 'qualitative',
        economicObjectId: null,
        evidenceStatus: 'unknown',
        importance: 2,
        urgency: 2,
        novelty: 1,
      },
    };
    const { reasoner } = await adapter({
      drafts: [
        risk,
        {
          ...risk,
          question: { ...risk.question, mechanism: 'rent_indexation' },
          conclusion: 'Price-indexation exposure is unknown.',
        },
      ],
    });
    const result = await reasoner.analyze(input);
    expect(result).toHaveLength(2);
    expect(result[0]?.conclusion).toBe('Financing exposure is unknown.');
    expect(result[1]?.conclusion).toBe('Price-indexation exposure is unknown.');
    expect(result[0]?.effectKey).not.toBe(result[1]?.effectKey);
    expect(result[0]?.calculation).toBeUndefined();
    expect(result[0]?.impact?.evidenceStatus).toBe('unknown');
  });

  it('leaves duplicate quantified consequences for the final uniqueness guard', async () => {
    const amount = {
      objectHandle: 'o0',
      assessment: { conditions: [], unknowns: [] },
      question: {
        mechanism: 'financing_cost',
        frame: 'absolute',
        unit: 'RUB',
        targetPeriod: '2026',
        baselinePeriod: null,
        basis: 'contract_total',
      },
      status: 'forecast',
      conclusion: 'Synthetic calculation.',
      sourceHandles: ['s0'],
      calculation: { expression: '1', unit: 'RUB', period: '2026-11' },
      impact: {
        metric: 'expense_delta',
        amountBasis: 'contract_total',
        economicObjectId: null,
        evidenceStatus: 'supported',
        importance: 2,
        urgency: 2,
        novelty: 1,
      },
    };
    const { reasoner } = await adapter({ drafts: [amount, amount] });
    const result = await reasoner.analyze(input);
    expect(result).toHaveLength(2);
    expect(result.map((draft) => draft.effectKey)).toEqual(['draft-0', 'draft-1']);
  });

  it('lets the model repair condition citations before accepting the company result', async () => {
    const source = {
      ...context.news,
      materialId: 'company-profile',
      kind: 'company' as const,
      companyIds: [companyId],
      contentHash: 'b'.repeat(64),
    };
    const draft = {
      objectHandle: 'o0',
      question: {
        mechanism: 'financing_cost',
        frame: 'event_only',
        unit: 'qualitative',
        targetPeriod: 'unknown',
        baselinePeriod: null,
        basis: 'qualitative',
      },
      assessment: {
        conditions: [
          {
            fact: 'Profile flag only',
            predicate: 'Exposure needs confirmation',
            status: 'supported',
            sourceHandles: ['s1'],
          },
        ],
        unknowns: [],
      },
      conclusion: 'Exposure remains unknown',
      status: 'unknown',
      impact: {
        metric: 'risk',
        amountBasis: 'qualitative',
        economicObjectId: null,
        evidenceStatus: 'unknown',
        importance: 1,
        urgency: 1,
        novelty: 1,
      },
      sourceHandles: ['s0'],
      calculation: null,
    };
    const adapterResult = await adapter({ drafts: [draft] }, true, 'submit_news_analysis', {
      drafts: [{ ...draft, sourceHandles: ['s0', 's1'] }],
    });
    const result = await adapterResult.reasoner.analyze({
      ...input,
      context: { ...context, materials: [source] },
    });
    expect(result[0]?.sourceRefs.map((s) => s.materialId)).toEqual([
      'synthetic-news',
      'company-profile',
    ]);
    expect(adapterResult.requests).toHaveLength(2);
    expect(JSON.stringify(adapterResult.requests[1])).toContain('condition');
  });

  it('lets the model repair a CSV-only conditional claim to unknown before terminating', async () => {
    let validations = 0;
    const insights = await createHttpService(async (request) => {
      expect(new URL(request.url).pathname).toBe('/internal/analyses/validate-applicability');
      expect(request.headers.get('X-Internal-Secret')).toBe('test-internal-secret');
      const input = await request.json();
      expect(input.candidates).toHaveLength(1);
      validations++;
      return validations === 1
        ? Response.json(
            { errorMessage: 'CSV profile is insufficient; preserve unknown' },
            { status: 422 },
          )
        : Response.json({ valid: true });
    });
    servers.push(insights);
    vi.stubEnv('INSIGHT_SERVICE_URL', insights.url);

    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://unused-context.test');
    vi.stubEnv('INTERNAL_SECRET', 'test-internal-secret');
    const profile = {
      ...context.news,
      materialId: 'csv-profile',
      sourceId: 'provided-bank-csv',
      kind: 'company' as const,
      companyIds: [companyId],
      contentHash: 'b'.repeat(64),
    };
    const draft = {
      objectHandle: 'o0',
      question: {
        mechanism: 'financing_cost',
        frame: 'event_only',
        unit: 'qualitative',
        targetPeriod: 'unknown',
        baselinePeriod: null,
        basis: 'qualitative',
      },
      assessment: {
        conditions: [],
        unknowns: [],
        applicability: {
          status: 'established',
          basis: 'documented_exposure',
          explanation: 'CSV flag',
          sourceHandles: ['s1'],
          assumptions: ['Rate change scenario'],
        },
      },
      conclusion: 'Fixture conditional based only on profile',
      status: 'conditional',
      impact: {
        metric: 'risk',
        amountBasis: 'qualitative',
        economicObjectId: null,
        evidenceStatus: 'conditional',
        importance: 1,
        urgency: 1,
        novelty: 1,
      },
      sourceHandles: ['s0', 's1'],
      calculation: null,
    };
    const repaired = {
      ...draft,
      status: 'unknown',
      impact: { ...draft.impact, evidenceStatus: 'unknown' },
      assessment: {
        ...draft.assessment,
        applicability: {
          ...draft.assessment.applicability,
          status: 'unknown',
          basis: 'profile_signal',
          assumptions: [],
        },
      },
    };
    const result = await adapter({ drafts: [draft] }, true, 'submit_news_analysis', {
      drafts: [repaired],
    });
    const saved = await result.reasoner.analyze({
      ...input,
      context: { ...context, materials: [profile] },
    });
    expect(saved[0]?.impact?.evidenceStatus).toBe('unknown');
    expect(result.requests).toHaveLength(2);
    expect(JSON.stringify(result.requests[1])).toContain('CSV');
    expect(validations).toBe(2);
  });

  it('packs whole optional originals against full review overhead and preserves cited evidence', async () => {
    const cited = {
      ...context.news,
      materialId: 'own-source',
      kind: 'company' as const,
      companyIds: [companyId],
      text: 'Own complete original',
      contentHash: 'b'.repeat(64),
    };
    const optional = {
      ...context.news,
      materialId: 'optional-market',
      kind: 'market' as const,
      text: 'Я'.repeat(70000),
      contentHash: 'c'.repeat(64),
    };
    const fresh = structuredClone(input);
    fresh.context.materials = [cited, optional];
    const drafts = Array.from({ length: 8 }, (_, i) => ({
      effectKey: `q-${i}`,
      literalObjectRef: `company:${companyId}`,
      expectedPreviousRevisionId: null,
      conclusion: 'Review evidence '.repeat(850),
      status: 'unknown',
      sourceRefs: [
        {
          materialId: cited.materialId,
          versionId: cited.versionId,
          contentHash: cited.contentHash,
        },
      ],
    }));
    const result = await adapter({ drafts: [] });
    await result.reasoner.review?.(fresh, drafts, {});
    expect(fresh.context.materials).toEqual([cited]);
    expect(fresh.context.coverage.complete).toBe(false);
    expect(fresh.context.coverage.budget?.omittedSources).toContainEqual({
      materialId: optional.materialId,
      versionId: optional.versionId,
      contentHash: optional.contentHash,
    });
    expect(JSON.stringify(result.requests[0]).length).toBeLessThan(180000);
    expect(JSON.stringify(result.requests[0])).toContain('Own complete original');
  });

  it('charges repeated original reads against the cumulative tool response budget', async () => {
    const original = {
      ...context.news,
      materialId: 'large-company',
      kind: 'company' as const,
      companyIds: [companyId],
      text: 'Я'.repeat(65000),
      contentHash: 'b'.repeat(64),
    };
    const service = await createHttpService(async () => Response.json(original));
    servers.push(service);
    vi.stubEnv('CONTEXT_SERVICE_URL', service.url);
    vi.stubEnv('INTERNAL_SECRET', 'test-internal-secret');
    const calls = await toolSequence([
      { name: 'context_read_original', arguments: { sourceHandle: 's1' } },
      { name: 'context_read_original', arguments: { sourceHandle: 's1' } },
      { name: 'submit_news_analysis', arguments: { drafts: [] } },
    ]);
    const fresh: ReasoningInput = structuredClone(input);
    fresh.context.materials = [original];
    expect(await createNativeNewsReasoner().analyze(fresh)).toEqual([]);
    expect(fresh.toolTrace).toContainEqual(
      expect.objectContaining({ stopReason: 'context_budget' }),
    );
    expect(JSON.stringify(calls[2])).toContain('does not fit');
    expect(original.text).toHaveLength(65000);
  });

  it('returns an out-of-scope mechanism to the model for repair before terminating', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://unused-context.test');
    vi.stubEnv('INTERNAL_SECRET', 'test-internal-secret');
    const draft = {
      objectHandle: 'o0',
      question: {
        mechanism: 'demand',
        frame: 'event_only',
        unit: 'qualitative',
        targetPeriod: 'unknown',
        baselinePeriod: null,
        basis: 'qualitative',
      },
      assessment: { conditions: [], unknowns: [] },
      conclusion: 'Fixture unknown',
      status: 'unknown',
      impact: {
        metric: 'risk',
        amountBasis: 'qualitative',
        economicObjectId: null,
        evidenceStatus: 'unknown',
        importance: 1,
        urgency: 1,
        novelty: 1,
      },
      sourceHandles: ['s0'],
      calculation: null,
    };
    const repaired = { ...draft, question: { ...draft.question, mechanism: 'financing_cost' } };
    const result = await adapter({ drafts: [draft] }, true, 'submit_news_analysis', {
      drafts: [repaired],
    });
    const fresh: ReasoningInput = structuredClone(input);
    fresh.request.mechanisms = ['financing_cost'];
    const output = await result.reasoner.analyze(fresh);
    expect(output[0]?.question?.mechanism).toBe('financing_cost');
    expect(result.requests).toHaveLength(2);
    expect(JSON.stringify(result.requests[1])).toContain('outside the requested scope');
  });

  it('aborts a timed-out model phase and retries in a fresh conversation', async () => {
    const result = await adapter({ drafts: [] });
    const actualTimeout = AbortSignal.timeout.bind(AbortSignal);
    let first = true;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      if (ms === 180000 && first) {
        first = false;
        return AbortSignal.abort(new DOMException('Fixture timeout', 'TimeoutError'));
      }
      return actualTimeout(ms);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await result.reasoner.analyze(structuredClone(input))).toEqual([]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('news.model_retry'))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns planner citation errors to the model before terminating the phase', async () => {
    vi.stubEnv('CONTEXT_SERVICE_URL', 'http://unused-context.test');
    vi.stubEnv('INTERNAL_SECRET', 'test-internal-secret');
    const original = {
      ...context.news,
      materialId: 'full-original',
      kind: 'market' as const,
      contentHash: 'b'.repeat(64),
    };
    const ref = (s: typeof context.news) => ({
      materialId: s.materialId,
      versionId: s.versionId,
      contentHash: s.contentHash,
    });
    const insight = {
      title: 'Conditional financing risk',
      conclusion: 'Exposure remains unknown',
      mechanism: 'Financing conditions',
      applicability: [],
      exclusions: [],
      unknowns: ['Contract unknown'],
      sourceRefs: [ref(original)],
    };
    const invalid = {
      eventSummary: 'Observed public event',
      queries: ['financing'],
      generalInsights: [insight],
    };
    const valid = {
      ...invalid,
      generalInsights: [{ ...insight, sourceRefs: [ref(context.news), ref(original)] }],
    };
    const calls = await toolSequence([
      { name: 'plan_news_insights', arguments: invalid },
      { name: 'plan_news_insights', arguments: valid },
    ]);
    expect(
      await createFlowReasoner().plan(context.news, [original], 'lead', { asOf: time }),
    ).toEqual(valid);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toContain('triggering news');
  });

  it('repairs unavailable evidence handles and derives trigger and source citations on the host', async () => {
    const market = { ...context.news, kind: 'market' as const, materialId: 'fixture-market' };
    const ref = (s: typeof context.news) => ({
      materialId: s.materialId,
      versionId: s.versionId,
      contentHash: s.contentHash,
    });
    const insight = {
      title: 'Fixture',
      conclusion: 'Conditional fixture',
      mechanism: 'demand',
      applicability: [],
      exclusions: [],
      unknowns: ['Own data unknown'],
      sourceRefs: [ref(context.news), ref(market)],
    };
    const good = {
      sourceCoverage: sourceUnits([market]).map((u) => ({
        unitId: u.unitId,
        disposition: 'used' as const,
        insightIndexes: [0],
        reason: 'fixture',
        signals: [],
      })),
      eventSummary: 'fixture',
      queries: ['fixture'],
      generalInsights: [insight],
      segmentCoverage: [{ segmentKey: 'okved2:45', insightIndexes: [0], reason: 'fixture' }],
    };
    const modelGood = segmentInput(good, sourceUnits([market]));
    const bad = {
      ...modelGood,
      generalInsights: modelGood.generalInsights.map((i) => ({
        ...i,
        sourceUnitIds: ['unavailable-unit'],
      })),
    };
    const calls = await toolSequence(
      [modelGood, bad, modelGood].map((arguments_) => ({
        name: 'plan_news_insights',
        arguments: arguments_,
      })),
    );
    expect(
      await createFlowReasoner().segments?.(
        context.news,
        [market],
        [{ key: 'okved2:45', labels: ['Cars'], companyIds: [companyId], profileRefs: [] }],
        time,
      ),
    ).toEqual(good);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[2])).toContain('sourceUnitIds');
  });
  it('retains inventoried signals without falsely marking an unlinked window as used', async () => {
    const market = { ...context.news, kind: 'market' as const, materialId: 'fixture-market' };
    const unit = sourceUnits([market])[0];
    if (!unit) throw new Error('Fixture requires a source window');
    const raw = {
      eventSummary: 'Observed source signal; no segment conclusion',
      queries: [],
      generalInsights: [],
      sourceCoverage: [
        {
          unitId: unit.unitId,
          signals: ['Forecast; exposure unknown'],
          disposition: 'used',
          reason: 'Inventoried',
        },
      ],
      segmentCoverage: [{ segmentKey: 'okved2:45', reason: 'No supported segment mechanism' }],
    };
    const calls = await toolSequence(
      [raw, raw].map((arguments_) => ({ name: 'plan_news_insights', arguments: arguments_ })),
    );
    const result = await createFlowReasoner().segments?.(
      context.news,
      [market],
      [{ key: 'okved2:45', labels: ['Cars'], companyIds: [companyId], profileRefs: [] }],
      time,
    );
    expect(calls).toHaveLength(2);
    expect(result?.sourceCoverage).toEqual([
      {
        ...raw.sourceCoverage[0],
        disposition: 'background',
        insightIndexes: [],
        reason: 'No linked insight; source signals retained. Inventoried',
      },
    ]);
    expect(result?.generalInsights).toEqual([]);
  });

  it('extracts and reviews source signals through native tools with exact quote validation', async () => {
    const source = {
      ...context.news,
      kind: 'market' as const,
      text: 'Independent demand observation.',
    };
    const unit = sourceUnits([source])[0];
    if (!unit) throw new Error('Missing fixture unit');
    const raw = {
      units: [
        {
          unitId: unit.unitId,
          disposition: 'signals',
          reason: 'Observation',
          signals: [
            {
              kind: 'observation',
              statement: 'Demand observation',
              quote: source.text,
              period: 'unknown',
              scope: 'sector',
              mechanisms: ['demand'],
            },
          ],
        },
      ],
    };
    const calls = await toolSequence([
      { name: 'extract_source_signals', arguments: raw },
      {
        name: 'review_source_signals',
        arguments: {
          units: [
            {
              unitId: unit.unitId,
              action: 'keep',
              reason: 'Checked exact evidence and completeness',
              replacement: null,
            },
          ],
        },
      },
    ]);
    const inventory = await createFlowReasoner().signals?.([source]);
    expect(inventory?.[0]?.signals[0]).toMatchObject({
      quote: source.text,
      sourceRef: { materialId: source.materialId },
    });
    expect(calls).toHaveLength(2);
  });

  it('reconciles a persisted source review created before the targeted-review protocol', async () => {
    const source = { ...context.news, kind: 'market' as const, text: 'Archive footer.' };
    const units = sourceUnits([source]);
    const raw = {
      units: units.map((u) => ({
        unitId: u.unitId,
        disposition: 'background',
        reason: 'No economic signal',
        signals: [],
      })),
    };
    await adapter(raw, true, 'extract_source_signals');
    const result = await runNewsAgent(
      SourceSignalsReviewAgent,
      'Legacy durable task',
      { signalUnits: units, instructions: 'Review originals' },
      { environment: {}, phase: 'legacy-review-test', errorCode: 'TEST_ERROR' },
    );
    expect(result).toMatchObject({
      inventories: [{ units: [{ disposition: 'background' }], signals: [] }],
    });
  });
  it('uses compact signal inventories for native segment proposal and review', async () => {
    const source = {
      ...context.news,
      kind: 'market' as const,
      text: 'Independent demand observation.',
    };
    const unit = sourceUnits([source])[0];
    if (!unit) throw new Error('Missing fixture unit');
    const inventories = extractInventories(
      {
        units: [
          {
            unitId: unit.unitId,
            disposition: 'signals',
            reason: 'Observation',
            signals: [
              {
                kind: 'observation',
                statement: 'Demand observation',
                quote: source.text,
                period: 'unknown',
                scope: 'sector',
                mechanisms: ['demand'],
              },
            ],
          },
        ],
      },
      [unit],
    );
    const raw = {
      eventSummary: 'Fixture',
      queries: [],
      generalInsights: [],
      signalCoverage: [
        {
          signalId: inventories[0]?.signals[0]?.signalId ?? 'missing-fixture-signal',
          disposition: 'not_applicable',
          reason: 'Different niche, preserved signal',
        },
      ],
      segmentCoverage: [
        { segmentKey: 'activity:62', reason: 'Software, no connection in fixture' },
      ],
    };
    const provider = await toolSequence([
      {
        name: 'plan_news_insights',
        arguments: { plan: { ...raw, signalCoverage: [] }, coveragePatch: null },
      },
      { name: 'plan_news_insights', arguments: { plan: null, coveragePatch: raw.signalCoverage } },
      { name: 'plan_news_insights', arguments: { plan: raw, coveragePatch: null } },
    ]);
    const result = await createFlowReasoner().segments?.(
      context.news,
      [source],
      [{ key: 'activity:62', labels: ['Software'], companyIds: [companyId], profileRefs: [] }],
      time,
      inventories,
    );
    expect(result?.signalCoverage).toHaveLength(1);
    expect(result?.sourceCoverage?.[0]?.disposition).toBe('background');
    expect(provider).toHaveLength(3);
    const bounded = await toolSequence(
      Array.from({ length: 6 }, () => ({
        name: 'plan_news_insights',
        arguments: { plan: { ...raw, signalCoverage: [] }, coveragePatch: null },
      })),
    );
    await expect(
      createFlowReasoner().segments?.(
        context.news,
        [source],
        [{ key: 'activity:62', labels: ['Software'], companyIds: [companyId], profileRefs: [] }],
        time,
        inventories,
      ),
    ).rejects.toMatchObject({ code: 'FLOW_MODEL_FORMAT' });
    expect(bounded).toHaveLength(6);
  });

  it('executes a native segment phase with fixed public inputs and no company tools', async () => {
    const plan = {
      sourceCoverage: [],
      eventSummary: 'Fixture sector',
      queries: [],
      generalInsights: [],
      segmentCoverage: [{ segmentKey: 'okved2:45', insightIndexes: [], reason: 'No evidence' }],
    };
    const provider = await adapter(
      segmentInput({ ...plan, eventSummary: 'Fixture draft with incorrect comparison basis' }, []),
      true,
      'plan_news_insights',
      segmentInput(plan, []),
    );
    const deadlines = vi.spyOn(AbortSignal, 'timeout');
    try {
      expect(
        await createFlowReasoner().segments?.(
          context.news,
          [],
          [{ key: 'okved2:45', labels: ['Cars'], companyIds: [companyId], profileRefs: [] }],
          time,
        ),
      ).toEqual(plan);
      expect(provider.requests).toHaveLength(2);
      expect(deadlines.mock.calls.filter(([ms]) => ms === 360000)).toHaveLength(2);
    } finally {
      deadlines.mockRestore();
    }
  });
  it('runs the news planner and role projection as isolated Flue conversations', async () => {
    const plan = {
      eventSummary: 'Synthetic tariff change',
      queries: ['synthetic tariff'],
      generalInsights: [],
    };
    const planner = await adapter(plan, true, 'plan_news_insights');
    expect(await createFlowReasoner().plan(context.news, [], 'full')).toEqual(plan);
    expect(planner.requests).toHaveLength(1);
    const role = { actions: [], missingContext: ['Synthetic missing contract'] };
    const projection = await adapter(role, true, 'project_role_actions');
    expect(
      await createFlowReasoner().role(
        { personId: 'F_TEST', companyId, role: 'treasury', responsibilities: ['payments'] },
        [],
      ),
    ).toEqual(role);
    expect(projection.requests).toHaveLength(1);
    expect(JSON.stringify(planner.requests)).not.toContain('F_TEST');
    expect(JSON.stringify(projection.requests)).not.toContain('Synthetic future tariff');
  });

  it('repairs fabricated relevance evidence and preserves unknown in the native routing phase', async () => {
    const document = {
      ...context.news,
      kind: 'company' as const,
      materialId: 'own-archive',
      text: 'Administrative archive.',
      companyIds: [companyId],
    };
    const calls = await toolSequence([
      {
        name: 'assess_evidence_relevance',
        arguments: {
          assessments: [
            { handle: 'd0', status: 'unrelated', reason: 'Invented basis', quote: 'No debt.' },
          ],
        },
      },
      {
        name: 'assess_evidence_relevance',
        arguments: {
          assessments: [
            {
              handle: 'd0',
              status: 'unknown',
              reason: 'Archive does not establish whether operational exposure exists',
              quote: '',
            },
          ],
        },
      },
    ]);
    const result = await createFlowReasoner().relevance?.(
      context.news,
      {
        eventSummary: 'Cost shock',
        queries: [],
        mechanisms: ['financing_cost'],
        generalInsights: [],
      },
      [document],
    );
    expect(result).toEqual([
      {
        sourceRef: {
          materialId: document.materialId,
          versionId: document.versionId,
          contentHash: document.contentHash,
        },
        status: 'unknown',
        reason: 'Archive does not establish whether operational exposure exists',
        quote: '',
      },
    ]);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toContain('Quote exact evidence');
  });

  it('repairs an over-budget segment result inside the phase before reviewing full originals', async () => {
    const market = { ...context.news, kind: 'market' as const, materialId: 'fixture-market' };
    const ref = (s: typeof context.news) => ({
      materialId: s.materialId,
      versionId: s.versionId,
      contentHash: s.contentHash,
    });
    const insight = {
      title: 'Fixture',
      conclusion: 'Conditional',
      mechanism: 'demand',
      applicability: [],
      exclusions: [],
      unknowns: ['Own data missing'],
      sourceRefs: [ref(context.news), ref(market)],
    };
    const good = {
      eventSummary: 'fixture',
      queries: ['fixture'],
      generalInsights: [insight],
      segmentCoverage: [{ segmentKey: 'okved2:45', insightIndexes: [0], reason: 'fixture' }],
      sourceCoverage: sourceUnits([market]).map((u) => ({
        unitId: u.unitId,
        disposition: 'used' as const,
        insightIndexes: [0],
        reason: 'fixture',
        signals: [],
      })),
    };
    const large = {
      ...good,
      generalInsights: [
        {
          ...insight,
          conclusion: 'a'.repeat(6000),
          mechanism: 'a'.repeat(4000),
          applicability: Array(16).fill('a'.repeat(1000)),
          exclusions: Array(16).fill('a'.repeat(1000)),
          unknowns: Array(16).fill('a'.repeat(1000)),
        },
      ],
    };
    const calls = await toolSequence(
      [large, { ...good, sourceCoverage: [] }, good, good].map((arguments_) => ({
        name: 'plan_news_insights',
        arguments: segmentInput(arguments_, sourceUnits([market])),
      })),
    );
    expect(
      await createFlowReasoner().segments?.(
        context.news,
        [market],
        [{ key: 'okved2:45', labels: ['Cars'], companyIds: [companyId], profileRefs: [] }],
        time,
      ),
    ).toEqual(good);
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls[1])).toContain('reserved review budget');
    expect(JSON.stringify(calls[2])).toContain('every source unit');
  });

  it('records phase duration and provider usage with configured secrets redacted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'news-phase-trace-'));
    try {
      const { requests } = await adapter({ drafts: [] });
      const fakeSecret = 'fake-"internal\\secret';
      const traced = createNativeNewsReasoner({
        NEWS_TRACE_DIRECTORY: directory,
        LLM_API_KEY: 'native-test-key',
        INTERNAL_SECRET: fakeSecret,
      });
      await traced.analyze({
        ...input,
        context: {
          ...context,
          news: { ...context.news, text: `Synthetic string ${fakeSecret}` },
        },
      });
      expect(requests).toHaveLength(1);
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      const raw = await readFile(join(directory, files[0] ?? ''), 'utf8');
      const trace = JSON.parse(raw);
      const promptEvent = trace.events.find(
        (event: { type: string }) => event.type === 'message-appended',
      );
      const prompt = JSON.parse(promptEvent.message.parts[0].text);
      expect(prompt.context.news.text).toBe('Synthetic string [REDACTED]');
      expect(trace.phase).toBe('company-proposal');
      expect(trace.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(trace.metadata.usage).toHaveProperty('totalTokens');
      expect(trace.failure).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
