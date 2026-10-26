import { setProvider } from '@flue/runtime';
import { type Flue, start } from '@flue/runtime/node';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CompanyConsequencesAgent } from '../src/agents/news-analysis.ts';
import { createModelProvider } from '../src/config/model.ts';
import { contextBundleSchema } from '../src/news-analysis/contracts/analysis.ts';
import { createNativeNewsReasoner } from '../src/news-analysis/reasoning/company-reasoner.ts';
import { ServiceClient } from '../src/news-analysis/transport/http/service-client.ts';
import { createHttpService } from './helpers/http-service.ts';

let runtime: Flue;
const servers: Awaited<ReturnType<typeof createHttpService>>[] = [];
beforeEach(async () => {
  runtime = await start({ agents: [CompanyConsequencesAgent], providers: [] });
});
afterEach(async () => {
  await runtime.stop();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.unstubAllEnvs();
});

it.each([
  { errorMessage: 'CONCLUSION_CLAIM_VALUE_MISMATCH: PRIVATE-ARGUMENT-SECRET' },
  { code: 'CONCLUSION_UNBOUND_NUMBER', message: 'PRIVATE-ARGUMENT-SECRET' },
])('exposes only the approved conclusion error code and a fixed safe remedy', async (payload) => {
  const fetcher: typeof fetch = async () => Response.json(payload, { status: 422 });
  const error = await new ServiceClient('http://insight.test', 'fake-only', fetcher)
    .request('/internal/analyses/prepare', {})
    .catch((failure: unknown) => failure);
  expect(error).toMatchObject({ status: 422, code: expect.stringMatching(/^CONCLUSION_/) });
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('Expected typed failure');
  expect(error.message).not.toContain('PRIVATE-ARGUMENT-SECRET');
  expect(error.message).toContain('calculation result');
});

it('repairs a lexical 800 claim against fake independently computed 8000 without rewriting the narrative or claim', async () => {
  const companyId = '11111111-1111-4111-8111-111111111111';
  const time = '2026-10-26T08:00:00Z';
  const source = (materialId: string, kind: 'news' | 'company', text: string) => ({
    materialId,
    versionId: 'v1',
    sourceId: 'synthetic-only',
    kind,
    title: materialId,
    text,
    knownAt: time,
    companyIds: kind === 'company' ? [companyId] : [],
    bankProfileIds: [],
    contentHash: (kind === 'news' ? 'a' : 'b').repeat(64),
  });
  const context = contextBundleSchema.parse({
    news: source('claim-news', 'news', 'SYNTHETIC ONLY: index changes from 8% to 9% for 2027.'),
    materials: [
      source(
        'claim-own',
        'company',
        'Loan Native-Claim-001: principal RUB 800000 is constant throughout 2027 and the rate immediately resets from 8% to 9%.',
      ),
    ],
    coverage: {
      complete: true,
      materialCount: 2,
      companyMaterialCount: 1,
      marketMaterialCount: 0,
      previousNewsVersionCount: 0,
      characters: 300,
      asOf: time,
    },
  });
  const narrative = (amount: string) =>
    `  Изменение расходов составит ${amount} RUB за 2027 год.\n`;
  const raw = (amount: string) => ({
    drafts: [
      {
        category: 'risk',
        objectHandle: 'o1',
        question: {
          mechanism: 'financing_cost',
          frame: 'event_only',
          unit: 'RUB',
          targetPeriod: '2027',
          baselinePeriod: null,
          basis: 'contract_total',
        },
        conclusion: narrative(amount),
        calculationClaimQuote: `${amount} RUB`,
        status: 'forecast',
        sourceHandles: ['s0', 's1'],
        assessment: {
          conditions: [],
          unknowns: [],
          applicability: {
            status: 'established',
            basis: 'documented_exposure',
            explanation: 'Own synthetic loan.',
            sourceHandles: ['s1'],
            assumptions: [],
          },
        },
        impact: {
          metric: 'expense_delta',
          amountBasis: 'contract_total',
          economicObjectHandle: 'e0',
          evidenceStatus: 'supported',
          importance: 0,
          urgency: 1,
          novelty: 1,
        },
        companyImportance: {
          score: null,
          rationale: 'Business scale is unknown.',
          evidenceSourceHandles: [],
        },
        calculation: { expression: '800000*(0.09-0.08)', unit: 'RUB', period: '2027' },
      },
    ],
  });
  const prepared: unknown[] = [];
  const backend = await createHttpService(async (request) => {
    expect(new URL(request.url).pathname).toBe('/internal/analyses/prepare');
    const data = z
      .object({
        drafts: z.array(
          z
            .object({
              conclusion: z.string(),
              calculationClaim: z.object({
                quote: z.string(),
                value: z.string(),
                unit: z.string(),
                period: z.string(),
              }),
            })
            .passthrough(),
        ),
      })
      .parse(await request.json());
    prepared.push(data.drafts);
    if (data.drafts[0]?.calculationClaim.value !== '8000')
      return Response.json(
        { errorMessage: 'CONCLUSION_CLAIM_VALUE_MISMATCH: PRIVATE-ARGUMENT-SECRET' },
        { status: 422 },
      );
    return Response.json({
      drafts: data.drafts.map((draft) => ({ ...draft, expectedPreviousRevisionId: null })),
    });
  });
  servers.push(backend);
  vi.stubEnv('INSIGHT_SERVICE_URL', backend.url);
  vi.stubEnv('INTERNAL_SECRET', 'fixture-only');
  const bodies: string[] = [];
  const provider = await createHttpService(async (request) => {
    bodies.push(await request.text());
    const result = raw(bodies.length === 1 ? '800' : '8000');
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: 'test-model', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `c${bodies.length}`,
            type: 'function',
            function: { name: 'submit_news_analysis', arguments: JSON.stringify(result) },
          },
        ],
      }) +
        chunk({}, 'tool_calls') +
        'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  servers.push(provider);
  setProvider(
    createModelProvider({
      LLM_BASE_URL: `${provider.url}/v1`,
      LLM_API_KEY: 'fake-only',
      LLM_MODEL: 'test-model',
    }),
  );
  const result = await createNativeNewsReasoner({
    CONTEXT_SERVICE_URL: backend.url,
    INTERNAL_SECRET: 'fixture-only',
  }).analyze({
    request: {
      companyId,
      newsMaterialId: context.news.materialId,
      newsVersionId: 'v1',
      asOf: time,
    },
    context,
    previousEffects: [],
  });
  expect(bodies).toHaveLength(2);
  expect(prepared).toHaveLength(2);
  expect(prepared[0]).toMatchObject([
    {
      conclusion: narrative('800'),
      calculationClaim: { quote: '800 RUB', value: '800', unit: 'RUB', period: '2027' },
    },
  ]);
  expect(prepared[1]).toMatchObject([
    {
      conclusion: narrative('8000'),
      calculationClaim: { quote: '8000 RUB', value: '8000', unit: 'RUB', period: '2027' },
    },
  ]);
  expect(result[0]?.conclusion).toBe(narrative('8000'));
  expect(result[0]?.calculationClaim?.value).toBe('8000');
  expect(result[0]?.companyImportance?.score).toBeNull();
  expect(bodies[1]).toContain('CONCLUSION_CLAIM_VALUE_MISMATCH');
  expect(bodies[1]).not.toContain('PRIVATE-ARGUMENT-SECRET');
  const tool = z
    .object({
      tools: z.array(
        z.object({ function: z.object({ name: z.string(), parameters: z.unknown() }) }),
      ),
    })
    .parse(JSON.parse(bodies[0] ?? '{}'))
    .tools.find((entry) => entry.function.name === 'submit_news_analysis');
  const properties = z
    .object({
      properties: z.object({
        drafts: z.object({ items: z.object({ properties: z.record(z.string(), z.unknown()) }) }),
      }),
    })
    .parse(tool?.function.parameters).properties.drafts.items.properties;
  expect(properties).toHaveProperty('calculationClaimQuote');
  expect(properties).not.toHaveProperty('calculationClaim');
});

it('does not forward an unapproved conclusion prefix or its arbitrary suffix', async () => {
  const fetcher: typeof fetch = async () =>
    Response.json(
      { code: 'CONCLUSION_PRIVATE_UNAPPROVED', message: 'PRIVATE-ARGUMENT-SECRET' },
      { status: 422 },
    );
  await expect(
    new ServiceClient('http://insight.test', 'fake-only', fetcher).request(
      '/internal/analyses/prepare',
      {},
    ),
  ).rejects.toMatchObject({
    code: 'UPSTREAM_ERROR',
    message: 'Upstream service rejected the request',
  });
});
