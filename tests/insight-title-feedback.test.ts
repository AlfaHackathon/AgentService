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

it.each(['TITLE_REQUIRED', 'TITLE_INVALID', 'TITLE_NUMERIC_REQUIRES_CALCULATION'])(
  'retains only safe machine feedback for %s',
  async (code) => {
    const fetcher: typeof fetch = async () =>
      Response.json({ errorMessage: `${code}: PRIVATE-UPSTREAM-DATA` }, { status: 422 });
    const error = await new ServiceClient('http://insight.test', 'fake-only', fetcher)
      .request('/internal/analyses/prepare', {})
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code, status: 422 });
    if (!(error instanceof Error)) throw new Error('Expected typed error');
    expect(error.message).not.toContain('PRIVATE-UPSTREAM-DATA');
    expect(error.message).toContain('title');
  },
);

it('does not expose unknown TITLE-prefixed error messages', async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({ code: 'TITLE_UNAPPROVED', message: 'PRIVATE-UPSTREAM-DATA' }, { status: 422 });
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

it.each(['mismatched_amount', 'missing_title', 'numeric_without_calculation'] as const)(
  'repairs %s through the actual native producer and fake canonical backend',
  async (shape) => {
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
      news: source('title-news', 'news', 'SYNTHETIC ONLY: index A changes from 8% to 9% for 2027.'),
      materials: [
        source(
          'title-own',
          'company',
          'Loan Native-Title-001: principal RUB 800000 is constant throughout 2027 and immediately resets from 8% to 9% with index A.',
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
    const conclusion = '  Условия договора указывают на рост расходов; проверьте применимость.\n';
    const hasCalculation = shape !== 'numeric_without_calculation';
    function raw(corrected: boolean) {
      const title =
        shape === 'mismatched_amount'
          ? `Расходы: ${corrected ? '8000' : '800'} RUB`
          : corrected
            ? 'Рост расходов требует проверки условий'
            : shape === 'missing_title'
              ? undefined
              : 'Рост расходов в 2027 году';
      return {
        drafts: [
          {
            ...(title !== undefined ? { title } : {}),
            category: 'risk',
            objectHandle: 'o1',
            question: {
              mechanism: 'financing_cost',
              frame: 'event_only',
              unit: hasCalculation ? 'RUB' : 'qualitative',
              targetPeriod: hasCalculation ? '2027' : 'unknown',
              baselinePeriod: null,
              basis: hasCalculation ? 'contract_total' : 'qualitative',
            },
            conclusion,
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
              metric: hasCalculation ? 'expense_delta' : 'risk',
              amountBasis: hasCalculation ? 'contract_total' : 'qualitative',
              economicObjectHandle: hasCalculation ? 'e0' : null,
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
            ...(hasCalculation
              ? { calculation: { expression: '800000*(0.09-0.08)', unit: 'RUB', period: '2027' } }
              : {}),
            ...(shape === 'mismatched_amount'
              ? { calculationClaimQuote: `${corrected ? '8000' : '800'} RUB` }
              : {}),
          },
        ],
      };
    }
    const drafts: unknown[] = [];
    const errorCode =
      shape === 'mismatched_amount'
        ? 'CONCLUSION_CLAIM_VALUE_MISMATCH'
        : shape === 'missing_title'
          ? 'TITLE_REQUIRED'
          : 'TITLE_NUMERIC_REQUIRES_CALCULATION';
    const backend = await createHttpService(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/internal/analyses/validate-applicability')
        return Response.json({ valid: true });
      expect(path).toBe('/internal/analyses/prepare');
      const body = z
        .object({ drafts: z.array(z.record(z.string(), z.unknown())) })
        .parse(await request.json());
      drafts.push(body.drafts);
      if (drafts.length === 1)
        return Response.json(
          { errorMessage: `${errorCode}: PRIVATE-UPSTREAM-DATA` },
          { status: 422 },
        );
      return Response.json({
        drafts: body.drafts.map((draft) => ({ ...draft, expectedPreviousRevisionId: null })),
      });
    });
    servers.push(backend);
    vi.stubEnv('INSIGHT_SERVICE_URL', backend.url);
    vi.stubEnv('INTERNAL_SECRET', 'fixture-only');
    const bodies: string[] = [];
    const provider = await createHttpService(async (request) => {
      bodies.push(await request.text());
      const args = raw(bodies.length === 2);
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
              function: { name: 'submit_news_analysis', arguments: JSON.stringify(args) },
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
    expect(drafts).toHaveLength(2);
    for (const body of bodies) expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(65536);
    expect(bodies[1]).toContain(errorCode);
    expect(bodies[1]).not.toContain('PRIVATE-UPSTREAM-DATA');
    expect(result[0]?.conclusion).toBe(conclusion);
    expect(result[0]?.title).toBe(
      shape === 'mismatched_amount'
        ? 'Расходы: 8000 RUB'
        : 'Рост расходов требует проверки условий',
    );
    expect(result[0]?.companyImportance?.score).toBeNull();
    if (shape === 'mismatched_amount') {
      expect(drafts[0]).toMatchObject([
        {
          title: 'Расходы: 800 RUB',
          conclusion,
          calculationClaim: { quote: '800 RUB', value: '800', unit: 'RUB', period: '2027' },
        },
      ]);
      expect(result[0]?.calculationClaim).toEqual({
        quote: '8000 RUB',
        value: '8000',
        unit: 'RUB',
        period: '2027',
      });
      expect(conclusion).not.toContain('8000 RUB');
    } else expect(result[0]?.calculationClaim).toBeUndefined();
  },
);
