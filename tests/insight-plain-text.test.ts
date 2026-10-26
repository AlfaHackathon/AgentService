import { setProvider } from '@flue/runtime';
import { type Flue, start } from '@flue/runtime/node';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CompanyConsequencesAgent,
  NewsPlannerAgent,
  SegmentPlannerAgent,
  SegmentReviewAgent,
} from '../src/agents/news-analysis.ts';
import { createModelProvider } from '../src/config/model.ts';
import {
  draftSchema,
  effectsResponseSchema,
  materialSchema,
} from '../src/news-analysis/contracts/analysis.ts';
import { validateInsightResultText } from '../src/news-analysis/contracts/insight-plain-text.ts';
import type { SignalInventory } from '../src/news-analysis/contracts/signals.ts';
import { createNativeNewsReasoner } from '../src/news-analysis/reasoning/company-reasoner.ts';
import { createFlowReasoner } from '../src/news-analysis/reasoning/flow-reasoner.ts';
import { ServiceClient } from '../src/news-analysis/transport/http/service-client.ts';
import { createHttpService } from './helpers/http-service.ts';
import { newLoanQuestionResult, questionBindingReplay } from './helpers/question-binding-replay.ts';

let runtime: Flue;
const servers: Awaited<ReturnType<typeof createHttpService>>[] = [];
beforeEach(async () => {
  // Test-owned URLs may be supplied later by a fake service; inherited URLs
  // must never turn an accepted native draft into an external service call.
  vi.stubEnv('INSIGHT_SERVICE_URL', undefined);
  vi.stubEnv('CONTEXT_SERVICE_URL', undefined);
  vi.stubEnv('NEWS_SERVICE_URL', undefined);
  vi.stubEnv('INTERNAL_SECRET', 'plain-text-fixture-only');
  runtime = await start({
    agents: [CompanyConsequencesAgent, NewsPlannerAgent, SegmentPlannerAgent, SegmentReviewAgent],
    providers: [],
  });
});
afterEach(async () => {
  try {
    await runtime.stop();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(['personal', 'general'] as const)(
  'repairs %s Markdown without changing originals or plain paragraphs',
  async (kind) => {
    const original = '**Original evidence** with `literal OCR` and https://source.example/news';
    const conclusion = 'Plain paragraph: 2 * 3 = 6 and -2 RUB.\n\nPreserve this second paragraph.';
    const context = structuredClone(questionBindingReplay.context);
    context.news.text = original;
    const news = materialSchema.parse(context.news);
    const ref = {
      materialId: news.materialId,
      versionId: news.versionId,
      contentHash: news.contentHash,
    };
    const native = newLoanQuestionResult();
    const result = (corrected: boolean) =>
      kind === 'personal'
        ? {
            drafts: native.drafts.map((draft) => ({
              ...draft,
              title: 'Grounded title',
              conclusion: corrected ? conclusion : `**${conclusion}**`,
            })),
          }
        : {
            eventSummary: 'A grounded event',
            queries: ['Own exposure'],
            generalInsights: [
              {
                category: null,
                title: corrected ? 'Grounded title' : '**Grounded title**',
                conclusion,
                mechanism: 'A demand channel',
                applicability: [],
                exclusions: [],
                unknowns: ['Exposure unknown'],
                sourceRefs: [ref],
              },
            ],
          };
    const bodies: string[] = [];
    const server = await createHttpService(async (request) => {
      bodies.push(await request.text());
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `c${bodies.length}`,
              type: 'function',
              function: {
                name: kind === 'personal' ? 'submit_news_analysis' : 'plan_news_insights',
                arguments: JSON.stringify(result(bodies.length > 1)),
              },
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
        LLM_API_KEY: 'fake-only',
        LLM_MODEL: 'test-model',
      }),
    );
    const environment = { CONTEXT_SERVICE_URL: 'http://127.0.0.1:1', INTERNAL_SECRET: 'fake-only' };
    const output =
      kind === 'personal'
        ? await createNativeNewsReasoner(environment).analyze({
            request: structuredClone(questionBindingReplay.request),
            context,
            previousEffects: [],
          })
        : (await createFlowReasoner(environment).plan(news, [], 'full')).generalInsights;
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('INSIGHT_PLAIN_TEXT_REQUIRED');
    expect(bodies[1]).toContain(
      kind === 'personal' ? 'drafts[0].conclusion' : 'generalInsights[0].title',
    );
    expect(output[0]?.conclusion).toBe(conclusion);
    expect(output[0]?.title).toBe('Grounded title');
    for (const body of bodies) {
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(65536);
      expect(body).toContain('Original evidence');
      expect(body).toContain('https://source.example/news');
    }
    expect(context.news.text).toBe(original);
  },
);

it('returns only fixed plain-text feedback and hides unknown plain-text-prefixed upstream errors', async () => {
  const known: typeof fetch = async () =>
    Response.json(
      { errorMessage: 'INSIGHT_PLAIN_TEXT_REQUIRED: PRIVATE-UPSTREAM-TEXT' },
      { status: 422 },
    );
  await expect(
    new ServiceClient('http://insight.test', 'fake', known).request(
      '/internal/analyses/prepare',
      {},
    ),
  ).rejects.toMatchObject({
    status: 422,
    code: 'INSIGHT_PLAIN_TEXT_REQUIRED',
    message: 'Use plain text for insight title and conclusion; keep source URLs in metadata.',
  });
  const unknown: typeof fetch = async () =>
    Response.json(
      { errorMessage: 'INSIGHT_PLAIN_TEXT_UNAPPROVED: PRIVATE-UPSTREAM-TEXT' },
      { status: 422 },
    );
  await expect(
    new ServiceClient('http://insight.test', 'fake', unknown).request(
      '/internal/analyses/prepare',
      {},
    ),
  ).rejects.toMatchObject({
    status: 422,
    code: 'UPSTREAM_ERROR',
    message: 'Upstream service rejected the request',
  });
});

it.each([
  '**bold**',
  '__bold__',
  '`code`',
  'before ` after',
  '~~~js\ncode\n~~~',
  '# Heading',
  'paragraph\n  ###### Heading',
  '######',
  '#\r\n',
  '###\r',
  '[label](https://example.test)',
  '![image](asset)',
  '[label][reference]',
  '<https://example.test>',
  'Visit HTTPS://EXAMPLE.TEST',
  '*важно*',
  '_важно_',
  '*x*',
])('rejects generated formatting with a safe field path: %s', (text) => {
  try {
    validateInsightResultText('submit_news_analysis', {
      drafts: [{ title: 'Plain', conclusion: text }],
    });
    throw new Error('Expected plain-text rejection');
  } catch (error) {
    expect(error).toMatchObject({
      status: 422,
      code: 'INSIGHT_PLAIN_TEXT_REQUIRED',
      message: 'INSIGHT_PLAIN_TEXT_REQUIRED: drafts[0].conclusion',
    });
  }
});

it.each([
  'Plain paragraph.\n\nSecond paragraph.',
  '2 * 3 = 6',
  'a*b*c',
  '-2 RUB',
  '8000 RUB in 2027',
  'Смысл, факты и неизвестности.',
  'A # literal hash',
  '####### is not ATX',
  'abc_def_ghi',
  'A ~ value',
])('preserves plain narrative and arithmetic verbatim: %s', (text) => {
  const data = { drafts: [{ title: 'Plain', conclusion: text }] };
  const before = structuredClone(data);
  expect(() => validateInsightResultText('submit_news_analysis', data)).not.toThrow();
  expect(data).toEqual(before);
});

it.each([
  ['submit_news_analysis', { drafts: [{ title: '**bad**' }] }, 'drafts[0].title'],
  [
    'plan_news_insights',
    { generalInsights: [{ conclusion: '**bad**' }] },
    'generalInsights[0].conclusion',
  ],
  [
    'plan_news_insights',
    { plan: { generalInsights: [{ title: '**bad**' }] }, coveragePatch: null },
    'plan.generalInsights[0].title',
  ],
] as const)('checks only known generated result wrappers (%s)', (name, data, path) => {
  expect(() => validateInsightResultText(name, data)).toThrow(
    `INSIGHT_PLAIN_TEXT_REQUIRED: ${path}`,
  );
});

it('leaves source quotes, assessment facts, patches and legacy read DTOs intact', () => {
  const marked = '**literal source** and `OCR` https://source.example';
  const data = {
    drafts: [
      {
        title: 'Plain',
        conclusion: 'Plain',
        source: { text: marked },
        assessment: { conditions: [{ fact: marked }], unknowns: [{ fact: marked }] },
        calculationClaimQuote: '8000 RUB',
      },
    ],
    plan: null,
    coveragePatch: [{ reason: marked }],
  };
  const before = structuredClone(data);
  expect(() => validateInsightResultText('submit_news_analysis', data)).not.toThrow();
  expect(() =>
    validateInsightResultText('assess_evidence_relevance', { drafts: [{ conclusion: marked }] }),
  ).not.toThrow();
  expect(data).toEqual(before);
  for (const schema of [
    draftSchema.pick({ title: true, conclusion: true }),
    effectsResponseSchema.shape.effects.element.shape.currentRevision.pick({
      title: true,
      conclusion: true,
    }),
  ]) {
    const legacy = schema.parse({
      title: '**old title**',
      conclusion: marked,
    });
    expect(legacy.title).toBe('**old title**');
    expect(legacy.conclusion).toBe(marked);
  }
});

it('rejects wrapped signal-plan text before persistent normalization and accepts a full repaired plan', async () => {
  const news = structuredClone(questionBindingReplay.context.news);
  const market = materialSchema.parse({
    ...news,
    materialId: 'plain-source',
    kind: 'market',
    text: '**verbatim source**',
  });
  const ref = {
    materialId: market.materialId,
    versionId: market.versionId,
    contentHash: market.contentHash,
  };
  const inventories: SignalInventory[] = [
    {
      version: 1,
      sourceRef: ref,
      units: [{ unitId: 'u1', disposition: 'signals', reason: 'Original preserved' }],
      signals: [
        {
          signalId: 's1',
          unitId: 'u1',
          sourceRef: ref,
          kind: 'unknown',
          statement: 'Exposure unknown',
          quote: market.text,
          period: 'unknown',
          scope: 'General',
          mechanisms: ['demand'],
        },
      ],
    },
  ];
  const raw = (corrected: boolean) => ({
    plan: {
      eventSummary: 'Demand event',
      queries: [],
      signalCoverage: [],
      generalInsights: [
        {
          category: null,
          title: corrected ? 'Conditional demand' : '**Conditional demand**',
          conclusion: 'Exposure remains unknown.',
          mechanism: 'Demand channel',
          applicability: [],
          exclusions: [],
          unknowns: ['Exposure unknown'],
          signalIds: ['s1'],
          segmentKeys: ['activity:62'],
          quality: {
            decisionQuestion: 'What exposure exists?',
            distinctContribution: 'Unknown exposure retained',
            priority: 'medium',
            novelty: 'source_context',
          },
        },
      ],
      segmentCoverage: [{ segmentKey: 'activity:62', reason: 'Demand scenario only' }],
    },
    coveragePatch: null,
  });
  const wires: Array<{ tools: unknown; messages: unknown }> = [];
  const server = await createHttpService(async (request) => {
    const body = await request.text();
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(65536);
    wires.push(z.object({ tools: z.unknown(), messages: z.unknown() }).parse(JSON.parse(body)));
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `c${wires.length}`,
            type: 'function',
            function: {
              name: 'plan_news_insights',
              arguments: JSON.stringify(raw(wires.length > 1)),
            },
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
      LLM_API_KEY: 'fake-only',
      LLM_MODEL: 'test-model',
    }),
  );
  const result = await createFlowReasoner({}).segments?.(
    news,
    [market],
    [
      {
        key: 'activity:62',
        labels: ['Software'],
        companyIds: [questionBindingReplay.request.companyId],
        profileRefs: [],
      },
    ],
    questionBindingReplay.request.asOf,
    inventories,
  );
  expect(wires).toHaveLength(3); // Invalid full plan, repaired full plan, independent review.
  expect(JSON.stringify(wires[1]?.messages)).toContain(
    'INSIGHT_PLAIN_TEXT_REQUIRED: plan.generalInsights[0].title',
  );
  expect(wires[1]?.tools).toEqual(wires[0]?.tools); // Failed markup never enables the persisted-draft coverage-patch schema.
  expect(result?.generalInsights[0]?.title).toBe('Conditional demand');
  expect(inventories[0]?.signals[0]?.quote).toBe('**verbatim source**');
});

it('preserves unrelated existing INSIGHT domain codes', async () => {
  const fetcher: typeof fetch = async () =>
    Response.json(
      { code: 'INSIGHT_SCOPE_MISMATCH', message: 'Existing scope rejection' },
      { status: 422 },
    );
  await expect(
    new ServiceClient('http://insight.test', 'fake', fetcher).request(
      '/internal/analyses/prepare',
      {},
    ),
  ).rejects.toMatchObject({
    status: 422,
    code: 'INSIGHT_SCOPE_MISMATCH',
    message: 'Existing scope rejection',
  });
});
