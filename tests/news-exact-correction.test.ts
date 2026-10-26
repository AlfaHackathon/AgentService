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
  assessmentSchema,
  contextBundleSchema,
  effectsResponseSchema,
  sourceRefSchema,
} from '../src/news-analysis/contracts/analysis.ts';
import { questionSchema } from '../src/news-analysis/contracts/questions.ts';
import { createNativeNewsReasoner } from '../src/news-analysis/reasoning/company-reasoner.ts';
import { createHttpService } from './helpers/http-service.ts';

const retainedFixture = z
  .object({
    originalFixtureSha256: z.literal(
      '432a6ee87d97b12ab9b7668aca2476e76956f9771da4d900784a715beeff2d41',
    ),
    retainedToolCallId: z.string().length(29),
    nativeInputUtf8Bytes: z.literal(22261),
    nativeInputSha256: z.literal(
      '6948e8e545745673c28e31016202b840e740cdbf2333c8edb86eeda02c8a8c81',
    ),
    invalidArgumentsUtf8Bytes: z.literal(13116),
    invalidArgumentsSha256: z.literal(
      'f0bab779f2cf952b7c6760a5588d7e83da5c0165cf337c4dad6a86cae5eb9ec9',
    ),
    nativeInput: z.unknown(),
    invalidToolArguments: z.object({ drafts: z.array(z.record(z.string(), z.unknown())) }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('./fixtures/exact-company-proposal-correction.json', import.meta.url),
        'utf8',
      ),
    ),
  );
const native = z
  .object({
    request: analysisRequestSchema,
    context: contextBundleSchema,
    sourceCatalog: z.array(sourceRefSchema.extend({ handle: z.string() })),
    previousQuestions: z.array(
      z.object({
        handle: z.string(),
        literal: z.string(),
        question: questionSchema,
        economicObjectId: z.string().nullable(),
        conclusion: z.string(),
        assessment: z.unknown(),
        sourceHandles: z.array(z.string()),
        unavailableSourceRefs: z.array(sourceRefSchema).optional(),
      }),
    ),
  })
  .parse(retainedFixture.nativeInput);
const loaded = new Map(native.sourceCatalog.map(({ handle, ...ref }) => [handle, ref]));
function expandLoadedReferences(value: unknown) {
  const {
    sourceHandles = [],
    unavailableSourceRefs = [],
    ...rest
  } = z
    .object({
      sourceHandles: z.array(z.string()).optional(),
      unavailableSourceRefs: z.array(sourceRefSchema).optional(),
    })
    .passthrough()
    .parse(value);
  return {
    ...rest,
    sourceRefs: [
      ...sourceHandles.map((handle) => {
        const ref = loaded.get(handle);
        if (!ref) throw new Error('Unknown retained loaded handle');
        return ref;
      }),
      ...unavailableSourceRefs,
    ],
  };
}
function expandAssessment(value: unknown) {
  const assessment = z
    .object({ conditions: z.array(z.unknown()), applicability: z.unknown().optional() })
    .passthrough()
    .parse(value);
  return assessmentSchema.parse({
    ...assessment,
    conditions: assessment.conditions.map(expandLoadedReferences),
    ...(assessment.applicability
      ? { applicability: expandLoadedReferences(assessment.applicability) }
      : {}),
  });
}
function replayInput() {
  // These fixture-only storage fields were not retained or used by the model
  // projection. They are never persisted. The inverse-projection assertion below
  // proves that no replacement facts enter the actual model input.
  const previousEffects = effectsResponseSchema.parse({
    effects: native.previousQuestions.map((q, i) => ({
      effectId: `replay-only-${i}`,
      effectKey: `replay-only-${i}`,
      companyId: native.request.companyId,
      newsMaterialId: native.request.newsMaterialId,
      literalObjectRef: q.literal,
      history: [],
      currentRevision: {
        revisionId: `replay-only-${i}`,
        previousRevisionId: null,
        newsVersionId: native.request.newsVersionId,
        asOf: native.request.asOf,
        createdAt: native.request.asOf,
        status: 'replay_container_only',
        question: q.question,
        conclusion: q.conclusion,
        assessment: expandAssessment(q.assessment),
        sourceRefs: expandLoadedReferences(q).sourceRefs,
        impact: q.economicObjectId
          ? {
              metric: 'replay_container_only',
              amountBasis: 'replay_container_only',
              economicObjectId: q.economicObjectId,
              evidenceStatus: 'unknown',
              importance: 0,
              urgency: 0,
              novelty: 0,
            }
          : null,
      },
    })),
  }).effects;
  return {
    request: structuredClone(native.request),
    context: structuredClone(native.context),
    previousEffects,
  };
}
function restoreUnloadedReferences(
  value: unknown,
  catalog: Map<string, z.infer<typeof sourceRefSchema>>,
) {
  const { unavailableSourceRefHandles, ...rest } = z
    .object({ unavailableSourceRefHandles: z.array(z.string()).optional() })
    .passthrough()
    .parse(value);
  if (!unavailableSourceRefHandles) return rest;
  return {
    ...rest,
    unavailableSourceRefs: unavailableSourceRefHandles.map((handle) => {
      const ref = catalog.get(handle);
      if (!ref) throw new Error('Unbound unloaded alias');
      return ref;
    }),
  };
}
function inverseProjection(value: unknown) {
  const { unavailableReferenceCatalog, ...prompt } = z
    .object({
      unavailableReferenceCatalog: z.array(
        sourceRefSchema.extend({ handle: z.string(), availability: z.literal('not_loaded') }),
      ),
      previousQuestions: z.array(z.unknown()),
    })
    .passthrough()
    .parse(value);
  const catalog = new Map(
    unavailableReferenceCatalog.map(({ handle, availability: _availability, ...ref }) => [
      handle,
      ref,
    ]),
  );
  return {
    ...prompt,
    previousQuestions: prompt.previousQuestions.map((value) => {
      const q = z
        .object({
          assessment: z
            .object({ conditions: z.array(z.unknown()), applicability: z.unknown().optional() })
            .passthrough(),
        })
        .passthrough()
        .parse(restoreUnloadedReferences(value, catalog));
      return {
        ...q,
        assessment: {
          ...q.assessment,
          conditions: q.assessment.conditions.map((condition) =>
            restoreUnloadedReferences(condition, catalog),
          ),
          ...(q.assessment.applicability
            ? { applicability: restoreUnloadedReferences(q.assessment.applicability, catalog) }
            : {}),
        },
      };
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

it('replays exact retained proposal and keeps at least 1024 bytes for request variation without losing evidence', async () => {
  // Tools read process.env as well as trusted phase scope. Standalone replay
  // must not inherit configured service endpoints or credentials from a shell.
  vi.stubEnv('INSIGHT_SERVICE_URL', '');
  vi.stubEnv('CONTEXT_SERVICE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('NEWS_SERVICE_URL', '');
  vi.stubEnv('INTERNAL_SECRET', 'fixture-only');
  const compactInput = JSON.stringify(retainedFixture.nativeInput);
  const invalidArguments = JSON.stringify(retainedFixture.invalidToolArguments);
  expect(Buffer.byteLength(compactInput, 'utf8')).toBe(retainedFixture.nativeInputUtf8Bytes);
  expect(createHash('sha256').update(compactInput).digest('hex')).toBe(
    retainedFixture.nativeInputSha256,
  );
  expect(Buffer.byteLength(invalidArguments, 'utf8')).toBe(
    retainedFixture.invalidArgumentsUtf8Bytes,
  );
  expect(createHash('sha256').update(invalidArguments).digest('hex')).toBe(
    retainedFixture.invalidArgumentsSha256,
  );
  const input = replayInput();
  const before = structuredClone(input);
  const corrected = z
    .object({
      drafts: z.array(
        z
          .object({
            category: z.enum(['risk', 'opportunity', 'event']).nullable(),
            conclusion: z.string(),
            status: z.string(),
          })
          .passthrough(),
      ),
    })
    .parse({
      drafts: retainedFixture.invalidToolArguments.drafts.map((draft) => ({
        ...draft,
        category: draft.category === 'null' ? null : draft.category,
      })),
    });
  const runtime = await start({ agents: [CompanyConsequencesAgent], providers: [] });
  const bodies: string[] = [];
  const server = await createHttpService(async (request) => {
    expect(request.headers.get('authorization')).toBe('Bearer fake-exact-only');
    expect(request.headers.has('X-Internal-Secret')).toBe(false);
    const body = await request.text();
    bodies.push(body);
    if (Buffer.byteLength(body, 'utf8') > 65536)
      return Response.json({ error: { message: 'LOCAL_REQUEST_BYTES > 65536' } }, { status: 400 });
    // This is an explicit next fake-model submission, not producer coercion.
    const args = bodies.length === 1 ? retainedFixture.invalidToolArguments : corrected;
    const chunk = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'fake-exact', object: 'chat.completion.chunk', model: 'test-model', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const id =
      bodies.length === 1 ? retainedFixture.retainedToolCallId : 'explicit-correction-replay-id';
    return new Response(
      `${chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: 'submit_news_analysis', arguments: JSON.stringify(args) } }] }, null)}${chunk({}, 'tool_calls')}data: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  setProvider(
    createModelProvider({
      LLM_BASE_URL: `${server.url}/v1`,
      LLM_API_KEY: 'fake-exact-only',
      LLM_MODEL: 'test-model',
    }),
  );
  try {
    const drafts = await createNativeNewsReasoner({
      CONTEXT_SERVICE_URL: 'http://127.0.0.1:1',
      INTERNAL_SECRET: 'fixture-only',
    }).analyze(input);
    expect(drafts).toHaveLength(3);
    expect(drafts.map((draft) => draft.category)).toEqual(['risk', null, null]);
    expect(drafts.map((draft) => draft.conclusion)).toEqual(
      corrected.drafts.map((draft) => draft.conclusion),
    );
    expect(drafts.map((draft) => draft.status)).toEqual(
      corrected.drafts.map((draft) => draft.status),
    );
    for (const [i, draft] of drafts.entries()) {
      const expected = z
        .object({
          sourceHandles: z.array(z.string()),
          assessment: z.object({ unknowns: z.unknown() }),
        })
        .parse(corrected.drafts[i]);
      expect(draft.sourceRefs).toEqual(expected.sourceHandles.map((handle) => loaded.get(handle)));
      expect(draft.assessment?.unknowns).toEqual(expected.assessment.unknowns);
      expect(draft.calculation).toBeUndefined();
    }
    expect(input).toEqual(before);
    expect(bodies).toHaveLength(2);
    for (const body of bodies)
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(65536 - 1024);
    const wire = z
      .object({
        messages: z.array(
          z.object({
            role: z.string(),
            content: z.unknown(),
            tool_calls: z
              .array(z.object({ function: z.object({ arguments: z.string() }) }))
              .optional(),
          }),
        ),
      })
      .parse(JSON.parse(bodies[1] ?? '{}'));
    const userText = z
      .array(z.object({ text: z.string() }))
      .parse(wire.messages.find((m) => m.role === 'user')?.content)
      .map((part) => part.text)
      .join('');
    expect(inverseProjection(JSON.parse(userText))).toEqual(retainedFixture.nativeInput);
    const priorArguments = wire.messages.find((m) => m.role === 'assistant')?.tool_calls?.[0]
      ?.function.arguments;
    expect(JSON.parse(priorArguments ?? '{}')).toEqual(retainedFixture.invalidToolArguments);
    const feedback = z.string().parse(wire.messages.find((m) => m.role === 'tool')?.content);
    expect(Buffer.byteLength(feedback, 'utf8')).toBeLessThanOrEqual(512);
    expect(feedback).toContain('drafts.1.category');
    expect(feedback).toContain('drafts.2.category');
    expect(feedback).not.toContain('Received arguments:');
    process.stdout.write(
      `${JSON.stringify({ event: 'synthetic.exact_correction_wire', utf8: bodies.map((body) => Buffer.byteLength(body, 'utf8')), model: 'test-model', originalHistoricalHttpRetained: false })}\n`,
    );
  } finally {
    await runtime.stop();
    await server.close();
  }
});
