import { setProvider } from '@flue/runtime';
import { type Flue, start } from '@flue/runtime/node';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { CompanyConsequencesAgent } from '../src/agents/news-analysis.ts';
import { createModelProvider } from '../src/config/model.ts';
import {
  effectsResponseSchema,
  type ReasoningInput,
} from '../src/news-analysis/contracts/analysis.ts';
import { createNativeNewsReasoner } from '../src/news-analysis/reasoning/company-reasoner.ts';
import { createHttpService } from './helpers/http-service.ts';
import { newLoanQuestionResult, questionBindingReplay } from './helpers/question-binding-replay.ts';

let runtime: Flue;
const servers: Awaited<ReturnType<typeof createHttpService>>[] = [];
beforeEach(async () => {
  runtime = await start({ agents: [CompanyConsequencesAgent], providers: [] });
});
afterEach(async () => {
  await runtime.stop();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function fixture() {
  const input: ReasoningInput = {
    request: structuredClone(questionBindingReplay.request),
    context: structuredClone(questionBindingReplay.context),
    previousEffects: [],
  };
  const historical = [1, 2].map((n) => ({
    materialId: `synthetic-historical-${'m'.repeat(100)}`,
    versionId: `v${n}-${'v'.repeat(80)}`,
    contentHash: String(n).repeat(64),
  }));
  const known = input.context.materials[0];
  if (!known) throw new Error('Missing synthetic original');
  const knownRef = {
    materialId: known.materialId,
    versionId: known.versionId,
    contentHash: known.contentHash,
  };
  input.previousEffects = effectsResponseSchema.parse({
    effects: Array.from({ length: 5 }, (_, i) => ({
      effectId: `synthetic-effect-${i}`,
      effectKey: `synthetic-key-${i}`,
      companyId: input.request.companyId,
      newsMaterialId: input.request.newsMaterialId,
      literalObjectRef: `company:${input.request.companyId}`,
      history: [],
      currentRevision: {
        revisionId: `prior-${i}`,
        previousRevisionId: null,
        newsVersionId: 'historical',
        asOf: input.request.asOf,
        createdAt: input.request.asOf,
        question: questionBindingReplay.previousQuestions[0]?.question,
        conclusion: `Исторический вывод ${i}; ноль не установлен.`,
        status: 'unknown',
        impact: null,
        sourceRefs: [...historical, knownRef],
        assessment: {
          conditions: Array.from({ length: 4 }, (_, c) => ({
            id: `condition_${c}`,
            assertion: 'observed',
            dependsOn: [],
            fact: `Условие ${i}/${c} из исторической версии.`,
            predicate: 'Факт требуется проверить.',
            status: 'unknown',
            sourceRefs: [...historical, knownRef],
          })),
          unknowns: [
            {
              id: `unknown_${i}`,
              fact: `Неизвестный факт ${i}, не равный нулю.`,
              query: null,
              scope: 'company',
              materialId: historical[0]?.materialId ?? null,
            },
          ],
        },
      },
    })),
  }).effects;
  return { input, historical };
}

async function provider(results: unknown[] = [{ drafts: [] }]) {
  const bodies: string[] = [];
  const server = await createHttpService(async (request) => {
    const body = await request.text();
    bodies.push(body);
    const delta = {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `c${bodies.length}`,
          type: 'function',
          function: {
            name: 'submit_news_analysis',
            arguments: JSON.stringify(results[Math.min(bodies.length - 1, results.length - 1)]),
          },
        },
      ],
    };
    const chunk = (value: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', model: 'test-model', created: 1, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
    return new Response(`${chunk(delta, null)}${chunk({}, 'tool_calls')}data: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
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

async function run(input: ReasoningInput) {
  const bodies = await provider();
  expect(await createNativeNewsReasoner({}).analyze(input)).toEqual([]);
  const wire = z
    .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
    .parse(JSON.parse(bodies[0] ?? '{}'));
  const text = z
    .array(z.object({ text: z.string() }))
    .parse(wire.messages.find((m) => m.role === 'user')?.content)
    .map((p) => p.text)
    .join('');
  return { prompt: z.record(z.string(), z.unknown()).parse(JSON.parse(text)), bodies };
}

it.each(['analyze', 'review'] as const)(
  'encodes repeated unloaded historical identities once in %s without granting evidence or losing any question/unknown',
  async (phase) => {
    const { input, historical } = fixture();
    const before = structuredClone(input);
    const raw = newLoanQuestionResult();
    const bodies = await provider([
      { drafts: raw.drafts.map((d) => ({ ...d, sourceHandles: ['s0', 'u0'] })) },
      { drafts: [] },
    ]);
    const reasoner = createNativeNewsReasoner({
      CONTEXT_SERVICE_URL: 'http://127.0.0.1:1',
      INTERNAL_SECRET: 'fixture-only',
    });
    expect(
      await (phase === 'analyze' ? reasoner.analyze(input) : reasoner.review?.(input, [], {})),
    ).toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('TOOL_ARGUMENT_SCHEMA');
    expect(bodies[1]).toContain('sourceHandles');
    const wire = z
      .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
      .parse(JSON.parse(bodies[0] ?? '{}'));
    const text = z
      .array(z.object({ text: z.string() }))
      .parse(wire.messages.find((m) => m.role === 'user')?.content)
      .map((p) => p.text)
      .join('');
    const prompt = z
      .object({
        unavailableReferenceCatalog: z.array(
          z.object({
            handle: z.string(),
            materialId: z.string(),
            versionId: z.string(),
            contentHash: z.string(),
            availability: z.literal('not_loaded'),
          }),
        ),
        previousQuestions: z.array(
          z.object({
            handle: z.string(),
            literal: z.string(),
            question: z.unknown(),
            economicObjectId: z.string().nullable(),
            conclusion: z.string(),
            sourceHandles: z.array(z.string()),
            unavailableSourceRefHandles: z.array(z.string()),
            assessment: z.object({
              conditions: z.array(
                z.object({
                  id: z.string(),
                  assertion: z.string(),
                  dependsOn: z.array(z.string()),
                  fact: z.string(),
                  predicate: z.string(),
                  status: z.string(),
                  sourceHandles: z.array(z.string()),
                  unavailableSourceRefHandles: z.array(z.string()),
                }),
              ),
              unknowns: z.unknown(),
            }),
          }),
        ),
      })
      .parse(JSON.parse(text));
    expect(prompt.unavailableReferenceCatalog).toEqual(
      historical.map((ref, i) => ({ ...ref, handle: `u${i}`, availability: 'not_loaded' })),
    );
    expect(prompt.previousQuestions).toHaveLength(5);
    for (const [i, q] of prompt.previousQuestions.entries()) {
      const original = before.previousEffects[i]?.currentRevision;
      expect(q).toMatchObject({
        handle: `q${i}`,
        literal: before.previousEffects[i]?.literalObjectRef,
        question: original?.question,
        economicObjectId: null,
      });
      expect(q.conclusion).toBe(original?.conclusion);
      expect(q.sourceHandles).toEqual(['s1']);
      expect(q.unavailableSourceRefHandles).toEqual(['u0', 'u1']);
      expect(q.assessment.unknowns).toEqual(original?.assessment?.unknowns);
      expect(q.assessment.conditions).toEqual(
        original?.assessment?.conditions.map(({ sourceRefs: _refs, ...condition }) => ({
          ...condition,
          sourceHandles: ['s1'],
          unavailableSourceRefHandles: ['u0', 'u1'],
        })),
      );
    }
    const expandedQuestions = before.previousEffects.map((effect, i) => ({
      handle: `q${i}`,
      literal: effect.literalObjectRef,
      question: effect.currentRevision.question,
      economicObjectId: null,
      conclusion: effect.currentRevision.conclusion,
      assessment: {
        ...effect.currentRevision.assessment,
        conditions: effect.currentRevision.assessment?.conditions.map(
          ({ sourceRefs: _refs, ...condition }) => ({
            ...condition,
            sourceHandles: ['s1'],
            unavailableSourceRefs: historical,
          }),
        ),
      },
      sourceHandles: ['s1'],
      unavailableSourceRefs: historical,
    }));
    const rawPrompt = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
    expect(rawPrompt.context).toEqual(before.context);
    expect(rawPrompt.sourceCatalog).toEqual(
      [before.context.news, ...before.context.materials].map(
        ({ materialId, versionId, contentHash }, i) => ({
          handle: `s${i}`,
          materialId,
          versionId,
          contentHash,
        }),
      ),
    );
    const expandedText = JSON.stringify({
      ...rawPrompt,
      previousQuestions: expandedQuestions,
      unavailableReferenceCatalog: undefined,
    });
    // The original encoding differs only in these model-facing references. Reserve
    // a conservative 512 bytes for the new catalog instruction in the system message.
    const minimumSavings =
      Buffer.byteLength(JSON.stringify(expandedText), 'utf8') -
      Buffer.byteLength(JSON.stringify(text), 'utf8') -
      512;
    expect(minimumSavings).toBeGreaterThan(4096);
    process.stdout.write(
      `${JSON.stringify({ event: 'synthetic.history_reference_minimum_savings', bytes: minimumSavings })}\n`,
    );
    expect(input).toEqual(before);
    for (const body of bodies) expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(65536);
    process.stdout.write(
      `${JSON.stringify({ event: 'synthetic.history_reference_wire', utf8: bodies.map((body) => Buffer.byteLength(body, 'utf8')) })}\n`,
    );
  },
);

it('keeps unique historical references inline without adding a catalog', async () => {
  const { input, historical } = fixture();
  const first = input.previousEffects[0];
  const reference = historical[0];
  if (!first || !reference || !first.currentRevision.assessment) throw new Error('Invalid fixture');
  input.previousEffects = [first];
  first.currentRevision.sourceRefs = [reference];
  first.currentRevision.assessment.conditions = [];
  const { prompt } = await run(input);
  expect(prompt.unavailableReferenceCatalog).toBeUndefined();
  expect(prompt.previousQuestions).toMatchObject([
    { sourceHandles: [], unavailableSourceRefs: [reference] },
  ]);
});

it('keeps the previous encoding when repeated short identities do not pay for catalog and instruction overhead', async () => {
  const { input } = fixture();
  const first = input.previousEffects[0];
  if (!first?.currentRevision.assessment) throw new Error('Invalid fixture');
  const reference = { materialId: 'm', versionId: 'v', contentHash: 'a'.repeat(64) };
  input.previousEffects = [first];
  first.currentRevision.sourceRefs = [reference];
  first.currentRevision.assessment.conditions = [
    {
      id: 'only',
      fact: 'Сохраняется целиком.',
      predicate: 'Неизвестно.',
      status: 'unknown',
      sourceRefs: [reference],
    },
  ];
  const { prompt } = await run(input);
  expect(prompt.unavailableReferenceCatalog).toBeUndefined();
  expect(prompt.previousQuestions).toMatchObject([
    {
      unavailableSourceRefs: [reference],
      assessment: { conditions: [{ unavailableSourceRefs: [reference] }] },
    },
  ]);
});

it('retains unique inline identities alongside shared unloaded aliases and preserves applicability and nonhistorical trace', async () => {
  const { input, historical } = fixture();
  const first = input.previousEffects[0];
  if (!first?.currentRevision.assessment) throw new Error('Invalid fixture');
  const unique = { materialId: 'synthetic-once', versionId: 'v9', contentHash: 'f'.repeat(64) };
  first.currentRevision.sourceRefs.push(unique);
  first.currentRevision.assessment.applicability = {
    status: 'unknown',
    basis: 'not_established',
    explanation: 'Экспозиция неизвестна.',
    assumptions: ['Непроверенное предположение.'],
    sourceRefs: historical,
  };
  input.toolTrace = [
    {
      round: 1,
      queries: ['Полный адресный запрос.'],
      retrievedSources: historical,
      stopReason: 'no_new_evidence',
    },
  ];
  const { prompt } = await run(input);
  expect(z.array(z.unknown()).parse(prompt.previousQuestions)[0]).toMatchObject({
    unavailableSourceRefs: [unique],
    unavailableSourceRefHandles: ['u0', 'u1'],
    assessment: {
      applicability: {
        explanation: 'Экспозиция неизвестна.',
        assumptions: ['Непроверенное предположение.'],
        unavailableSourceRefHandles: ['u0', 'u1'],
      },
    },
  });
  expect(prompt.toolTrace).toEqual([
    {
      round: 1,
      queries: ['Полный адресный запрос.'],
      stopReason: 'no_new_evidence',
      sourceHandles: [],
      unavailableSourceRefs: historical,
    },
  ]);
});
