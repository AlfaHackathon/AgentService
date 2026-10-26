import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setProvider } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CompanyConsequencesAgent } from '../src/agents/news-analysis.ts';
import { createModelProvider } from '../src/config/model.ts';
import {
  analysisRequestSchema,
  contextBundleSchema,
  reasoningOutputSchema,
  sourceRefSchema,
} from '../src/news-analysis/contracts/analysis.ts';
import { runNewsAgent } from '../src/news-analysis/reasoning/agent-runner.ts';
import {
  conditionalRepair,
  exhaustedValidation,
  terminalValidation,
} from '../src/news-analysis/reasoning/tools/validation-feedback.ts';
import { createHttpService } from './helpers/http-service.ts';

const fixture = z
  .object({
    nativeInput: z
      .object({
        request: analysisRequestSchema,
        context: contextBundleSchema,
        proposedDrafts: z.array(z.record(z.string(), z.unknown())),
        previousQuestions: z.array(z.unknown()),
        objectCatalog: z.array(
          z.object({ handle: z.string(), literal: z.string(), sourceHandles: z.array(z.string()) }),
        ),
        sourceCatalog: z.array(sourceRefSchema.extend({ handle: z.string() })),
      })
      .passthrough(),
    submissions: z.array(z.object({ drafts: z.array(z.record(z.string(), z.unknown())) })),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/exact-conditional-final.json', import.meta.url), 'utf8'),
    ),
  );
const native = fixture.nativeInput;
const refs = (handles: string[]) =>
  handles.map((h) => {
    const r = native.sourceCatalog.find((r) => r.handle === h);
    if (!r) throw new Error('Unknown fixture handle');
    return { materialId: r.materialId, versionId: r.versionId, contentHash: r.contentHash };
  });
const proposed = reasoningOutputSchema.parse({
  drafts: native.proposedDrafts.map((d) => {
    const v = z
      .object({
        sourceHandles: z.array(z.string()),
        assessment: z.object({
          conditions: z.array(z.object({ sourceHandles: z.array(z.string()) }).passthrough()),
          applicability: z.object({ sourceHandles: z.array(z.string()) }).passthrough(),
          unknowns: z.array(z.unknown()),
        }),
        companyImportance: z.object({ evidenceSourceHandles: z.array(z.string()) }).passthrough(),
      })
      .passthrough()
      .parse(d);
    const { sourceHandles: _, ...rest } = v;
    return {
      ...rest,
      sourceRefs: refs(v.sourceHandles),
      assessment: {
        ...v.assessment,
        conditions: v.assessment.conditions.map(({ sourceHandles, ...c }) => ({
          ...c,
          sourceRefs: refs(sourceHandles),
        })),
        applicability: (({ sourceHandles, ...a }) => ({ ...a, sourceRefs: refs(sourceHandles) }))(
          v.assessment.applicability,
        ),
      },
      companyImportance: (({ evidenceSourceHandles, ...r }) => ({
        ...r,
        evidenceRefs: refs(evidenceSourceHandles),
      }))(v.companyImportance),
    };
  }),
}).drafts;
afterEach(() => vi.unstubAllEnvs());

it('retains byte-verified exact input and submissions from the synthetic source fixture', () => {
  const raw = z
    .object({
      originalFixtureSha256: z.literal(
        '012ff223846e07081f09e2163b8f737191789bc6e1be59fba4012bd46498b199',
      ),
      nativeInput: z.unknown(),
      submissions: z.unknown(),
      nativeInputSha256: z.string(),
      submissionsSha256: z.string(),
    })
    .parse(
      JSON.parse(
        readFileSync(new URL('./fixtures/exact-conditional-final.json', import.meta.url), 'utf8'),
      ),
    );
  expect(createHash('sha256').update(JSON.stringify(raw.nativeInput)).digest('hex')).toBe(
    raw.nativeInputSha256,
  );
  expect(createHash('sha256').update(JSON.stringify(raw.submissions)).digest('hex')).toBe(
    raw.submissionsSha256,
  );
});

async function replay(submissions: unknown[]) {
  vi.stubEnv('INSIGHT_SERVICE_URL', '');
  vi.stubEnv('CONTEXT_SERVICE_URL', '');
  vi.stubEnv('NEWS_SERVICE_URL', '');
  vi.stubEnv('INTERNAL_SECRET', 'fixture-only');
  const runtime = await start({ agents: [CompanyConsequencesAgent], providers: [] });
  const bodies: string[] = [];
  const server = await createHttpService(async (req) => {
    const body = await req.text();
    bodies.push(body);
    if (bodies.length > 2) throw new Error('Unexpected third submission');
    const chunk = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      chunk(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `c${bodies.length}`,
              type: 'function',
              function: {
                name: 'submit_news_analysis',
                arguments: JSON.stringify(submissions[bodies.length - 1]),
              },
            },
          ],
        },
        null,
      ) +
        chunk({}, 'tool_calls') +
        'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  setProvider(
    createModelProvider({
      LLM_BASE_URL: `${server.url}/v1`,
      LLM_API_KEY: 'fake-only',
      LLM_MODEL: 'test-model',
    }),
  );
  try {
    const result = await runNewsAgent(
      CompanyConsequencesAgent,
      JSON.stringify(native),
      {
        instructions: 'Return the fixed company-final result. Preserve evidence and unknowns.',
        companyScope: {
          companyId: native.request.companyId,
          asOf: native.request.asOf,
          sources: [native.context.news, ...native.context.materials],
          objects: native.objectCatalog,
          questions: [],
          proposedDrafts: proposed,
        },
        objectHandles: native.objectCatalog.map((o) => o.handle),
        sourceHandles: native.sourceCatalog.map((s) => s.handle),
      },
      { environment: {}, phase: 'company-final', errorCode: 'INVALID_REASONING_RESULT' },
    );
    return { result, bodies };
  } catch (error) {
    return { error, bodies };
  } finally {
    await runtime.stop();
    await server.close();
  }
}

it('repairs the exact invalid conditional final through one explicit unknown submission without manufacturing evidence', async () => {
  const second = structuredClone(fixture.submissions[0]);
  if (!second) throw new Error('Missing exact first submission');
  const draft = z
    .object({
      assessment: z.object({
        conditions: z.array(
          z
            .object({ assertion: z.string(), status: z.string(), dependsOn: z.array(z.string()) })
            .passthrough(),
        ),
        unknowns: z.array(z.object({ id: z.string() }).passthrough()),
        applicability: z.object({ assumptions: z.array(z.string()) }).passthrough(),
      }),
      impact: z.object({ evidenceStatus: z.string() }).passthrough(),
    })
    .passthrough()
    .parse(second.drafts[0]);
  draft.status = 'unknown';
  draft.conclusion =
    'Не установлено, совпадают ли индексы договора и новости; влияние на этот заем пока неизвестно. Расчёт и фактическая оплата не подтверждены.';
  draft.impact.evidenceStatus = 'unknown';
  draft.assessment.applicability.assumptions = [];
  for (const c of draft.assessment.conditions)
    if (c.assertion === 'conditional') {
      c.assertion = 'derived';
      c.status = 'unknown';
      c.dependsOn = ['loan_terms', 'news_index', 'index_identity_unknown'];
      c.fact = 'Влияние новости на начисленные проценты пока не установлено.';
    }
  second.drafts = [draft];
  const before = structuredClone(fixture);
  const out = await replay([fixture.submissions[0], second]);
  expect(out.error).toBeUndefined();
  expect(out.bodies).toHaveLength(2);
  expect(out.bodies[1]).toContain('INVALID_CONDITIONAL_EVIDENCE');
  expect(out.bodies[1]).toContain('dependentCondition');
  expect(out.bodies[1]).toContain('derived');
  expect(out.bodies[1]).toContain('unknown');
  const wire = z
    .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
    .parse(JSON.parse(out.bodies[1] ?? '{}'));
  const feedback = z.string().parse(wire.messages.find((m) => m.role === 'tool')?.content);
  expect(Buffer.byteLength(feedback, 'utf8')).toBeLessThanOrEqual(2048);
  expect(JSON.parse(feedback)).toMatchObject({
    httpStatus: 422,
    maximumCorrections: 1,
    saved: false,
    repair: {
      unknown: {
        status: 'unknown',
        evidenceStatus: 'unknown',
        dependentCondition: { assertion: 'derived', status: 'unknown' },
      },
    },
  });
  const result = z.object({ drafts: z.array(z.record(z.string(), z.unknown())) }).parse(out.result);
  expect(result.drafts[0]).toMatchObject({
    status: 'unknown',
    conclusion: draft.conclusion,
    impact: { evidenceStatus: 'unknown' },
    assessment: { unknowns: draft.assessment.unknowns },
  });
  expect(result.drafts[0]).not.toHaveProperty('calculation');
  expect(result.drafts[0]).toMatchObject({
    objectHandle: fixture.submissions[0]?.drafts[0]?.objectHandle,
    question: fixture.submissions[0]?.drafts[0]?.question,
    sourceHandles: fixture.submissions[0]?.drafts[0]?.sourceHandles,
  });
  const userText = z
    .array(z.object({ text: z.string() }))
    .parse(wire.messages.find((m) => m.role === 'user')?.content)
    .map((p) => p.text)
    .join('');
  expect(JSON.parse(userText)).toEqual(native);
  expect(fixture).toEqual(before);
});

it('preserves the last meaningful FINAL_CALCULATION_REQUIRED error when the exact two invalid submissions exhaust the budget', async () => {
  const out = await replay(fixture.submissions);
  expect(out.bodies).toHaveLength(2);
  expect(out.error).toMatchObject({ code: 'FINAL_CALCULATION_REQUIRED', status: 422 });
});

it('preserves repeated conditional validation failure without adding a third submission', async () => {
  const out = await replay([fixture.submissions[0], fixture.submissions[0]]);
  expect(out.bodies).toHaveLength(2);
  expect(out.error).toMatchObject({ code: 'INVALID_CONDITIONAL_EVIDENCE', status: 422 });
});

it('does not promote arbitrary errors, SDK feedback or other tool outputs to trusted terminal domain errors', () => {
  const diagnostic = JSON.stringify({
    status: 'invalid',
    origin: 'company_validation',
    code: 'FINAL_CALCULATION_REQUIRED',
    httpStatus: 422,
    saved: false,
    exhausted: true,
    maximumSubmissions: 2,
    maximumCorrections: 0,
    message: 'PRIVATE arbitrary data',
  });
  expect(exhaustedValidation('context_read_original', new Error(diagnostic), 2)).toBeUndefined();
  expect(
    exhaustedValidation('submit_news_analysis', new Error('PRIVATE arbitrary data'), 2),
  ).toBeUndefined();
  expect(terminalValidation(diagnostic)?.message).not.toContain('PRIVATE');
  expect(terminalValidation(diagnostic)?.code).toBe('FINAL_CALCULATION_REQUIRED');
  for (const input of [
    'not JSON',
    diagnostic.replace('FINAL_CALCULATION_REQUIRED', 'UPSTREAM_ERROR'),
    diagnostic.replace('"saved":false', '"saved":true'),
    diagnostic.replace('company_validation', 'source_data'),
    diagnostic.replace('"origin":"company_validation",', ''),
    diagnostic.replace('"exhausted":true', '"exhausted":false'),
    diagnostic.replace('"maximumSubmissions":2', '"maximumSubmissions":3'),
    diagnostic.replace('"maximumCorrections":0', '"maximumCorrections":1'),
    diagnostic + ' '.repeat(4096),
  ])
    expect(terminalValidation(input)).toBeUndefined();
  expect(conditionalRepair('FINAL_CALCULATION_REQUIRED')).toEqual({});
});
