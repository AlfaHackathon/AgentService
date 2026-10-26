import { setProvider } from '@flue/runtime';
import { type Flue, start } from '@flue/runtime/node';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { CompanyConsequencesAgent } from '../src/agents/news-analysis.ts';
import { createModelProvider } from '../src/config/model.ts';
import {
  contextBundleSchema,
  effectsResponseSchema,
  type ReasoningInput,
} from '../src/news-analysis/contracts/analysis.ts';
import { createNativeNewsReasoner } from '../src/news-analysis/reasoning/company-reasoner.ts';
import { resolveCompanyResult } from '../src/news-analysis/reasoning/company-result.ts';
import { createHttpService } from './helpers/http-service.ts';
import {
  newLoanQuestionResult,
  questionBindingReplay,
  questionBindingScope,
} from './helpers/question-binding-replay.ts';

let runtime: Flue;
const servers: Awaited<ReturnType<typeof createHttpService>>[] = [];
beforeEach(async () => {
  runtime = await start({ agents: [CompanyConsequencesAgent], providers: [] });
});
afterEach(async () => {
  await runtime.stop();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function provider(results: unknown[]) {
  const bodies: string[] = [];
  const server = await createHttpService(async (request) => {
    const body = await request.text();
    bodies.push(body);
    if (Buffer.byteLength(body, 'utf8') > 65536)
      return Response.json({ error: { message: 'LOCAL_REQUEST_BYTES > 65536' } }, { status: 400 });
    const result = results[Math.min(bodies.length - 1, results.length - 1)];
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(
      chunk({ role: 'assistant' }) +
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call-${bodies.length}`,
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
  servers.push(server);
  setProvider(
    createModelProvider({
      LLM_BASE_URL: `${server.url}/v1`,
      LLM_API_KEY: 'fake-only',
      LLM_MODEL: 'test-model',
    }),
  );
  return bodies;
}

function fixture() {
  const raw = newLoanQuestionResult();
  const scope = questionBindingScope();
  const input: ReasoningInput = {
    request: structuredClone(questionBindingReplay.request),
    context: structuredClone(questionBindingReplay.context),
    previousEffects: [],
  };
  const proposals = resolveCompanyResult(raw, scope);
  return { raw, input, proposals };
}

it('corrects missing sourceHandles once with complete originals and unknowns within the UTF-8 request budget', async () => {
  const { raw, input, proposals } = fixture();
  const draft = raw.drafts[0];
  if (!draft || !proposals[0]) throw new Error('Missing synthetic draft');
  // Duplicate citations and bounded retrieval history are bookkeeping, not more evidence.
  const refs = proposals[0].sourceRefs;
  input.toolTrace = Array.from({ length: 4 }, (_, round) => ({
    round,
    queries: ['Нужна точная идентичность индекса. '.repeat(28)],
    retrievedSources: Array.from({ length: 8 }, () => refs).flat(),
    stopReason: 'no_new_evidence',
  }));
  const missing = {
    drafts: raw.drafts.map((value) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'sourceHandles')),
    ),
  };
  const bodies = await provider([missing, raw]);
  const reviewed = await createNativeNewsReasoner({}).review?.(input, proposals, { results: [] });
  expect(reviewed).toHaveLength(1);
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(65536);
  process.stdout.write(
    `${JSON.stringify({ event: 'synthetic.company_final_request_bytes', utf8: bodies.map((body) => Buffer.byteLength(body, 'utf8')) })}\n`,
  );
  expect(bodies[1]).toContain('sourceHandles');
  expect(bodies[0]).toContain(input.context.news.text);
  expect(bodies[0]).toContain(input.context.materials[0]?.text);
  expect(reviewed?.[0]?.assessment?.unknowns).toEqual(proposals[0].assessment?.unknowns);
  const request = z
    .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
    .parse(JSON.parse(bodies[0] ?? '{}'));
  const correctedRequest = z
    .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
    .parse(JSON.parse(bodies[1] ?? '{}'));
  const feedback = JSON.stringify(
    correctedRequest.messages.find((message) => message.role === 'tool')?.content,
  );
  expect(feedback).toContain('sourceHandles');
  expect(feedback).toMatch(/required|Required/);
  const user = request.messages.find((message) => message.role === 'user');
  const text = z
    .array(z.object({ text: z.string() }))
    .parse(user?.content)
    .map((part) => part.text)
    .join('');
  const prompt = z
    .object({
      context: z.unknown(),
      arithmeticFeedback: z.unknown(),
      proposedDrafts: z.array(
        z.object({
          conclusion: z.string(),
          sourceHandles: z.array(z.string()),
          assessment: z.object({
            conditions: z.array(z.record(z.string(), z.unknown())),
            unknowns: z.unknown(),
          }),
        }),
      ),
      toolTrace: z.array(z.record(z.string(), z.unknown())),
    })
    .parse(JSON.parse(text));
  expect(prompt.context).toEqual(input.context);
  expect(prompt.arithmeticFeedback).toEqual({ results: [] });
  expect(prompt.proposedDrafts[0]?.conclusion).toBe(proposals[0].conclusion);
  expect(prompt.proposedDrafts[0]?.sourceHandles).toEqual(['s0', 's1']);
  expect(prompt.proposedDrafts[0]?.assessment.unknowns).toEqual(proposals[0].assessment?.unknowns);
  expect(prompt.proposedDrafts[0]?.assessment.conditions).toMatchObject(
    proposals[0].assessment?.conditions.map(({ sourceRefs: _refs, ...condition }) => condition) ??
      [],
  );
  expect(prompt.toolTrace).toMatchObject(
    input.toolTrace.map(({ retrievedSources: _refs, ...trace }) => trace),
  );
});

it('fails closed after one correction when sourceHandles remain missing', async () => {
  const { raw, input, proposals } = fixture();
  const missing = {
    drafts: raw.drafts.map((value) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'sourceHandles')),
    ),
  };
  const bodies = await provider([missing]);
  await expect(
    createNativeNewsReasoner({}).review?.(input, proposals, { results: [] }),
  ).rejects.toMatchObject({ code: 'INVALID_REASONING_RESULT' });
  expect(bodies).toHaveLength(2);
});

it('rejects an over-budget mandatory full original before any model transport without truncating it', async () => {
  const { raw, input, proposals } = fixture();
  input.context.news.text = 'Обязательный полный оригинал. '.repeat(6000);
  const before = structuredClone(input.context.news);
  const bodies = await provider([raw]);
  await expect(
    createNativeNewsReasoner({}).review?.(input, proposals, { results: [] }),
  ).rejects.toMatchObject({ code: 'MANDATORY_REASONING_CONTEXT_BUDGET' });
  expect(bodies).toEqual([]);
  expect(input.context.news).toEqual(before);
});

it('repairs final calculation omission through 422 feedback before accepting an explicit corrected expression', async () => {
  const { input } = fixture();
  const own = input.context.materials[0];
  if (!own) throw new Error('Missing synthetic original');
  input.context = contextBundleSchema.parse({
    ...input.context,
    materials: [
      {
        ...own,
        materialId: 'own-final',
        text: 'SYNTHETIC ONLY. Loan Loan-Final-001 has constant principal RUB 1000000 throughout 2027 and immediately resets from 12% to 14%.',
      },
    ],
  });
  const draft = {
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
    assessment: {
      conditions: [],
      unknowns: [],
      applicability: {
        status: 'established',
        basis: 'documented_exposure',
        explanation: 'The synthetic loan is documented.',
        sourceHandles: ['s1'],
        assumptions: [],
      },
    },
    conclusion: 'The synthetic contractual expense delta is 20000 RUB for 2027.',
    status: 'forecast',
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
    sourceHandles: ['s0', 's1'],
    calculation: { expression: '1000000*(0.14-0.12)', unit: 'RUB', period: '2027' },
  };
  const proposals = resolveCompanyResult(
    { drafts: [draft] },
    {
      companyId: input.request.companyId,
      asOf: input.request.asOf,
      sources: [input.context.news, ...input.context.materials],
      objects: [{ handle: 'o1', literal: 'Loan-Final-001', sourceHandles: ['s1'] }],
      questions: [],
    },
  );
  const { calculation: _omitted, ...omitted } = draft;
  const corrected = { ...draft, calculation: { ...draft.calculation, expression: '1000000*0.02' } };
  const bodies = await provider([{ drafts: [omitted] }, { drafts: [corrected] }]);
  const result = await createNativeNewsReasoner({}).review?.(input, proposals, {
    results: [{ valid: true, result: '20000', unit: 'RUB', period: '2027', arithmeticOnly: true }],
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain('FINAL_CALCULATION_REQUIRED');
  expect(bodies[1]).toContain('422');
  expect(bodies[1]).toContain('maximumCorrections');
  expect(result?.[0]?.calculation).toEqual({
    expression: {
      kind: 'multiply',
      left: { kind: 'value', value: '1000000' },
      right: { kind: 'value', value: '0.02' },
    },
    unit: 'RUB',
    period: '2027',
  });
  expect(result?.[0]?.calculation).not.toEqual(proposals[0]?.calculation);
  expect(result?.[0]?.companyImportance).toMatchObject({
    score: null,
    rationale: 'Business scale is unknown.',
  });
});

it('keeps an unavailable historical version and its unique assessment outside sourceHandles', async () => {
  const { raw, input, proposals } = fixture();
  const proposed = proposals[0];
  if (!proposed) throw new Error('Missing proposal');
  const oldRef = {
    materialId: 'synthetic-historical-only',
    versionId: 'old-version',
    contentHash: 'f'.repeat(64),
  };
  const assessment = {
    conditions: [
      {
        id: 'old',
        assertion: 'observed',
        dependsOn: [],
        fact: 'A unique historical condition remains unknown.',
        predicate: 'Old evidence needs revalidation.',
        status: 'unknown',
        sourceRefs: [oldRef],
      },
    ],
    unknowns: [
      {
        id: 'old_missing',
        fact: 'A unique historical missing fact is not erased.',
        query: null,
        scope: 'company',
        materialId: oldRef.materialId,
      },
    ],
    applicability: {
      status: 'unknown',
      basis: 'not_established',
      explanation: 'The historical source is not loaded.',
      assumptions: [],
      sourceRefs: [oldRef],
    },
  };
  input.previousEffects = effectsResponseSchema.parse({
    effects: [
      {
        effectId: 'old-effect',
        effectKey: 'old-key',
        companyId: input.request.companyId,
        newsMaterialId: input.request.newsMaterialId,
        literalObjectRef: proposed.literalObjectRef,
        currentRevision: {
          ...proposed,
          revisionId: 'old-revision',
          previousRevisionId: null,
          newsVersionId: input.request.newsVersionId,
          asOf: input.request.asOf,
          createdAt: input.request.asOf,
          impact: proposed.impact ?? null,
          sourceRefs: [oldRef],
          assessment,
        },
        history: [],
      },
    ],
  }).effects;
  const bodies = await provider([raw]);
  await createNativeNewsReasoner({}).review?.(input, proposals, { results: [] });
  const request = z
    .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
    .parse(JSON.parse(bodies[0] ?? '{}'));
  const user = request.messages.find((message) => message.role === 'user');
  const text = z
    .array(z.object({ text: z.string() }))
    .parse(user?.content)
    .map((part) => part.text)
    .join('');
  const prompt = z
    .object({
      previousQuestions: z.array(
        z.object({
          sourceHandles: z.array(z.string()),
          unavailableSourceRefs: z.array(z.unknown()),
          assessment: z.object({
            conditions: z.array(
              z.object({
                fact: z.string(),
                sourceHandles: z.array(z.string()),
                unavailableSourceRefs: z.array(z.unknown()),
              }),
            ),
            unknowns: z.unknown(),
            applicability: z.object({
              sourceHandles: z.array(z.string()),
              unavailableSourceRefs: z.array(z.unknown()),
            }),
          }),
        }),
      ),
    })
    .parse(JSON.parse(text));
  const question = prompt.previousQuestions[0];
  expect(question?.sourceHandles).toEqual([]);
  expect(question?.unavailableSourceRefs).toEqual([oldRef]);
  expect(question?.assessment.conditions[0]).toMatchObject({
    fact: assessment.conditions[0]?.fact,
    sourceHandles: [],
    unavailableSourceRefs: [oldRef],
  });
  expect(question?.assessment.applicability).toMatchObject({
    sourceHandles: [],
    unavailableSourceRefs: [oldRef],
  });
  expect(question?.assessment.unknowns).toEqual(assessment.unknowns);
});
