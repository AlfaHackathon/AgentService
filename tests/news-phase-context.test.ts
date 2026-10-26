import { createHash } from 'node:crypto';
import { setProvider } from '@flue/runtime';
import { type Flue, start } from '@flue/runtime/node';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EvidenceRelevanceAgent,
  NewsPlannerAgent,
  RoleProjectionAgent,
  SegmentPlannerAgent,
  SegmentReviewAgent,
  SourceSignalsAgent,
  SourceSignalsReviewAgent,
} from '../src/agents/news-analysis.ts';
import { createModelProvider } from '../src/config/model.ts';
import { materialSchema } from '../src/news-analysis/contracts/analysis.ts';
import type { NewsPlan } from '../src/news-analysis/contracts/flow.ts';
import { createFlowReasoner } from '../src/news-analysis/reasoning/flow-reasoner.ts';
import { extractInventories } from '../src/news-analysis/reasoning/source-signals.ts';
import type { Source } from '../src/news-analysis/retrieval/source-catalog.ts';
import { sourceUnits } from '../src/news-analysis/retrieval/source-units.ts';
import { createHttpService } from './helpers/http-service.ts';

const time = '2026-10-26T08:00:00Z';
const companyId = '11111111-1111-4111-8111-111111111111';
function source(id: string, kind: 'news' | 'market', text: string) {
  return materialSchema.parse({
    materialId: id,
    versionId: 'v1',
    contentHash: createHash('sha256').update(text).digest('hex'),
    sourceId: 'synthetic-phase-audit',
    kind,
    title: id,
    text,
    knownAt: time,
    companyIds: [],
    bankProfileIds: [],
  });
}
const news = source(
  'synthetic-phase-news',
  'news',
  'СИНТЕТИЧЕСКАЯ НОВОСТЬ: объявлено изменение условий спроса. Индивидуальная экспозиция компаний неизвестна. Конец полного оригинала новости.',
);
const quote = 'Прогноз спроса: +3% в 2027 году.';
const unknownQuote = 'Период второго показателя не установлен.';
const market = source(
  'synthetic-phase-market',
  'market',
  `СИНТЕТИЧЕСКАЯ АНАЛИТИКА. ${quote} Это прогноз, а не факт исполнения. ${unknownQuote} Исходное OCR обозначение нельзя достраивать. Конец полного оригинала аналитики.`,
);
const ref = ({ materialId, versionId, contentHash }: Source) => ({
  materialId,
  versionId,
  contentHash,
});
const units = sourceUnits([market]);
const segment = {
  key: 'activity:62',
  labels: ['Software'],
  companyIds: [companyId],
  profileRefs: [],
};
const unknowns = ['Company exposure and the period of the second indicator remain unknown.'];
const insight = {
  category: null,
  title: 'Conditional demand channel',
  conclusion:
    'A 2027 demand forecast can affect sales only for documented exposure; the second indicator period remains unknown.',
  mechanism: 'demand',
  applicability: ['Documented demand exposure is required.'],
  exclusions: ['No individual company effect is established.'],
  unknowns,
};
const plan: NewsPlan = {
  eventSummary: 'Synthetic announced demand change',
  queries: ['Documented demand exposure'],
  mechanisms: ['demand'],
  generalInsights: [{ ...insight, sourceRefs: [ref(news), ref(market)] }],
};
const extraction = {
  units: units.map((unit) => ({
    unitId: unit.unitId,
    disposition: 'signals',
    reason: 'Forecast and a separate unresolved period.',
    signals: [
      {
        kind: 'forecast',
        statement: quote,
        quote,
        period: '2027',
        scope: 'General demand forecast, not company exposure.',
        mechanisms: ['demand'],
      },
      {
        kind: 'unknown',
        statement: unknownQuote,
        quote: unknownQuote,
        period: 'unknown',
        scope: 'OCR does not establish the indicator period.',
        mechanisms: ['demand'],
      },
    ],
  })),
};
const inventories = extractInventories(extraction, units);

type Call = { phase: string; bytes: number; prompt: Record<string, unknown> };
let runtime: Flue;
const servers: Awaited<ReturnType<typeof createHttpService>>[] = [];
beforeEach(async () => {
  runtime = await start({
    agents: [
      NewsPlannerAgent,
      EvidenceRelevanceAgent,
      SourceSignalsAgent,
      SourceSignalsReviewAgent,
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
});

async function provider(steps: Array<{ phase: string; tool: string; result: unknown }>) {
  const calls: Call[] = [];
  const server = await createHttpService(async (request) => {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-phase-only');
    expect(request.headers.has('X-Internal-Secret')).toBe(false);
    const raw = await request.text();
    const body = z
      .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
      .parse(JSON.parse(raw));
    const user = body.messages.find((message) => message.role === 'user');
    const text = z
      .array(z.object({ text: z.string() }))
      .parse(user?.content)
      .map((part) => part.text)
      .join('');
    const step = steps[calls.length];
    if (!step) throw new Error('Unexpected additional model turn');
    const bytes = Buffer.byteLength(raw, 'utf8');
    expect(bytes).toBeGreaterThan(raw.length); // Cyrillic makes character counts insufficient.
    expect(bytes).toBeLessThanOrEqual(65536);
    calls.push({
      phase: step.phase,
      bytes,
      prompt: z.record(z.string(), z.unknown()).parse(JSON.parse(text)),
    });
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: 'test-model', created: 1, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(
      chunk({ role: 'assistant' }) +
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call-${calls.length}`,
              type: 'function',
              function: { name: step.tool, arguments: JSON.stringify(step.result) },
            },
          ],
        }) +
        chunk({}, 'tool_calls') +
        'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  servers.push(server);
  setProvider(
    createModelProvider({
      LLM_BASE_URL: `${server.url}/v1`,
      LLM_API_KEY: 'synthetic-phase-only',
      LLM_MODEL: 'test-model',
    }),
  );
  return calls;
}
function fullCopies(value: unknown, text: string): number {
  if (typeof value === 'string') return Number(value === text);
  if (Array.isArray(value)) return value.reduce((total, item) => total + fullCopies(item, text), 0);
  if (value && typeof value === 'object')
    return Object.values(value).reduce<number>((total, item) => total + fullCopies(item, text), 0);
  return 0;
}
function record(calls: Call[], count: number) {
  expect(calls).toHaveLength(count);
  process.stdout.write(
    `${JSON.stringify({ event: 'synthetic.phase_context_bytes', phases: calls.map(({ phase, bytes }) => ({ phase, bytes })) })}\n`,
  );
}

it('planner carries each full original once and retains source identities and unknowns', async () => {
  const calls = await provider([{ phase: 'planner', tool: 'plan_news_insights', result: plan }]);
  // Enable the native planner source validator; this valid result invokes no service tool.
  const result = await createFlowReasoner({
    CONTEXT_SERVICE_URL: 'http://127.0.0.1:1',
    INTERNAL_SECRET: 'synthetic-only',
  }).plan(news, [market], 'lead');
  record(calls, 1);
  expect(calls[0]?.prompt).toEqual({ news, publicSources: [market], textCompleteness: 'lead' });
  expect(fullCopies(calls[0]?.prompt, news.text)).toBe(1);
  expect(fullCopies(calls[0]?.prompt, market.text)).toBe(1);
  expect(result.generalInsights[0]).toMatchObject({
    unknowns,
    sourceRefs: [ref(news), ref(market)],
  });
});

it('relevance retains complete evidence and uncertainty while the host binds the quoted result', async () => {
  const calls = await provider([
    {
      phase: 'relevance',
      tool: 'assess_evidence_relevance',
      result: {
        assessments: [
          {
            handle: 'd0',
            status: 'related',
            reason: 'Exact forecast is a possible demand channel, not proof of exposure.',
            quote,
          },
        ],
      },
    },
  ]);
  const result = await createFlowReasoner({}).relevance?.(news, plan, [market]);
  record(calls, 1);
  expect(fullCopies(calls[0]?.prompt, news.text)).toBe(1);
  expect(fullCopies(calls[0]?.prompt, market.text)).toBe(1);
  expect(calls[0]?.prompt).toMatchObject({ sources: [{ ...market, handle: 'd0' }] });
  expect(JSON.stringify(calls[0]?.prompt)).toContain(unknownQuote);
  expect(result?.[0]).toMatchObject({ quote, sourceRef: ref(market) });
});

it('source extraction and review carry lossless windows once and retain exact forecast/unknown quotes', async () => {
  const calls = await provider([
    { phase: 'source-extraction', tool: 'extract_source_signals', result: extraction },
    {
      phase: 'source-review',
      tool: 'review_source_signals',
      result: {
        units: units.map((unit) => ({
          unitId: unit.unitId,
          action: 'keep',
          reason: 'Exact quote and explicit uncertainty checked.',
          replacement: null,
        })),
      },
    },
  ]);
  const result = await createFlowReasoner({}).signals?.([market]);
  record(calls, 2);
  for (const call of calls) {
    expect(fullCopies(call.prompt, market.text)).toBe(1);
    expect(call.prompt.sourceUnits).toEqual(units);
    expect(call.prompt.sources).toEqual([expect.not.objectContaining({ text: expect.anything() })]);
  }
  // Review intentionally overlaps original text with short immutable quotes in its draft.
  expect(calls[1]?.prompt.draft).toEqual({ inventories });
  expect(result?.[0]?.sourceRef).toEqual(ref(market));
  expect(result?.[0]?.signals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'forecast', quote, period: '2027', sourceRef: ref(market) }),
      expect.objectContaining({
        kind: 'unknown',
        quote: unknownQuote,
        period: 'unknown',
        sourceRef: ref(market),
      }),
    ]),
  );
});

it('legacy segment proposal/review retain complete windows once and preserve unknowns and host identities', async () => {
  const raw = {
    eventSummary: plan.eventSummary,
    queries: [],
    generalInsights: [
      { ...insight, sourceUnitIds: units.map((u) => u.unitId), segmentKeys: [segment.key] },
    ],
    sourceCoverage: units.map((u) => ({
      unitId: u.unitId,
      signals: [quote, unknownQuote],
      disposition: 'used',
      reason: 'Forecast and unresolved period preserved.',
    })),
    segmentCoverage: [
      { segmentKey: segment.key, reason: 'Conditional channel; exposure unknown.' },
    ],
  };
  const calls = await provider(
    ['legacy-segment-proposal', 'legacy-segment-review'].map((phase) => ({
      phase,
      tool: 'plan_news_insights',
      result: raw,
    })),
  );
  const result = await createFlowReasoner({}).segments?.(news, [market], [segment], time);
  record(calls, 2);
  for (const call of calls) {
    expect(fullCopies(call.prompt, news.text)).toBe(1);
    expect(fullCopies(call.prompt, market.text)).toBe(1);
    expect(call.prompt.sourceUnits).toEqual(units);
    expect(call.prompt.publicSources).toEqual([
      expect.not.objectContaining({ text: expect.anything() }),
    ]);
  }
  expect(calls[1]?.prompt.draft).toMatchObject({
    generalInsights: [{ unknowns }],
    sourceCoverage: [{ signals: [quote, unknownQuote] }],
  });
  expect(result?.generalInsights[0]).toMatchObject({
    unknowns,
    sourceRefs: [ref(news), ref(market)],
  });
  expect(result?.segmentCoverage?.[0]).toMatchObject({
    segmentKey: segment.key,
    insightIndexes: [0],
  });
});

it('inventory segment proposal/review use verified quotes instead of duplicating complete analytics', async () => {
  const raw = {
    eventSummary: plan.eventSummary,
    queries: [],
    signalCoverage: [],
    generalInsights: [
      {
        ...insight,
        signalIds: inventories.flatMap((i) => i.signals.map((s) => s.signalId)),
        segmentKeys: [segment.key],
        quality: {
          decisionQuestion: 'Which demand evidence needs company confirmation?',
          distinctContribution: 'Retains forecast and a separate unknown period.',
          priority: 'medium',
          novelty: 'source_context',
        },
      },
    ],
    segmentCoverage: [
      { segmentKey: segment.key, reason: 'Only conditional demand applicability.' },
    ],
  };
  const calls = await provider(
    ['inventory-segment-proposal', 'inventory-segment-review'].map((phase) => ({
      phase,
      tool: 'plan_news_insights',
      result: { plan: raw, coveragePatch: null },
    })),
  );
  const result = await createFlowReasoner({}).segments?.(
    news,
    [market],
    [segment],
    time,
    inventories,
  );
  record(calls, 2);
  for (const call of calls) {
    expect(fullCopies(call.prompt, news.text)).toBe(1);
    expect(fullCopies(call.prompt, market.text)).toBe(0);
    expect(call.prompt.sourceUnits).toEqual([]);
    expect(call.prompt.inventories).toEqual(inventories);
    expect(call.prompt.publicSources).toEqual([
      expect.not.objectContaining({ text: expect.anything() }),
    ]);
  }
  expect(calls[1]?.prompt.draft).toMatchObject({
    generalInsights: [{ unknowns }],
    signalCoverage: [],
  });
  expect(result?.generalInsights[0]).toMatchObject({
    unknowns,
    sourceRefs: [ref(news), ref(market)],
  });
  expect(
    result?.signalCoverage?.every(
      (row) => row.disposition === 'used' && row.insightIndexes.includes(0),
    ),
  ).toBe(true);
});

it('minimal role projection retains explicit responsibility and missing context without acquiring originals', async () => {
  const expected = {
    actions: [],
    missingContext: ['Documented company exposure remains unknown.'],
  };
  const calls = await provider([{ phase: 'role', tool: 'project_role_actions', result: expected }]);
  const profile = {
    personId: 'synthetic-person',
    companyId,
    role: 'treasury',
    responsibilities: ['Check documented exposure; do not invent a cash amount.'],
  };
  expect(await createFlowReasoner({}).role(profile, [])).toEqual(expected);
  record(calls, 1);
  expect(calls[0]?.prompt).toEqual({ profile, facts: [], groups: [], sourceCatalog: [] });
});
