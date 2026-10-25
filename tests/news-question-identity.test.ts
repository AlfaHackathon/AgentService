import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  type AnalysisRequest,
  contextBundleSchema,
  type EffectDraft,
} from '../src/news-analysis/contracts/analysis.ts';
import { businessQuestionKey } from '../src/news-analysis/contracts/business-questions.ts';
import { resolveCompanyResult } from '../src/news-analysis/reasoning/company-result.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';
import { objectCatalog } from '../src/news-analysis/retrieval/source-catalog.ts';

const request: AnalysisRequest = {
  companyId: '11111111-1111-4111-8111-111111111111',
  newsMaterialId: 'synthetic-benchmark-news',
  newsVersionId: 'v1',
  asOf: '2026-10-25T21:05:00Z',
};
function question(
  literalObjectRef = `company:${request.companyId}`,
): EffectDraft & { question: NonNullable<EffectDraft['question']> } {
  return {
    effectKey: 'draft-0',
    literalObjectRef,
    question: {
      mechanism: 'financing_cost',
      frame: 'event_only',
      unit: 'qualitative',
      targetPeriod: 'unknown',
      baselinePeriod: null,
      basis: 'qualitative',
    },
    conclusion: 'Synthetic loan index is unknown.',
    status: 'unknown',
    sourceRefs: [
      { materialId: 'synthetic-loan-one', versionId: 'v1', contentHash: 'a'.repeat(64) },
    ],
  };
}

describe('producer business question identity before persistence', () => {
  it('rejects two different loan drafts assigned the same company question before preparing or saving', async () => {
    const one = question();
    const two = {
      ...one,
      effectKey: 'draft-1',
      conclusion: 'A separate synthetic loan has an unnamed index and reset date.',
      sourceRefs: [
        { materialId: 'synthetic-loan-two', versionId: 'v1', contentHash: 'b'.repeat(64) },
      ],
    };
    const fetcher = vi.fn(async () =>
      Response.json({
        drafts: [one, two].map((draft) => ({ ...draft, expectedPreviousRevisionId: null })),
      }),
    );
    const client = new InsightClient('http://insight.test', 'test-secret', fetcher);
    await expect(client.prepare(request, [one, two])).rejects.toMatchObject({
      status: 422,
      code: 'DUPLICATE_BUSINESS_QUESTION',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

const replay = JSON.parse(
  readFileSync(
    new URL('./fixtures/fullflow-duplicate-business-question.json', import.meta.url),
    'utf8',
  ),
);
const context = contextBundleSchema.parse(replay.context);
const sources = [context.news, ...context.materials];
const replayScope = {
  companyId: replay.request.companyId,
  asOf: replay.request.asOf,
  sources,
  objects: objectCatalog(sources, replay.request.companyId),
  questions: [],
};
it('rejects the real synthetic attempt2 collision at the structured-result boundary', () => {
  expect(() => resolveCompanyResult(replay.rawResult, replayScope)).toThrowError(
    expect.objectContaining({ status: 422, code: 'DUPLICATE_BUSINESS_QUESTION' }),
  );
});
it('offers both documented loan identifiers so correction can preserve the distinct obligations', () => {
  expect(replayScope.objects.map((object) => object.literal)).toEqual([
    'company:d7aeac1f-432f-47bd-a826-0d55fbb3fccf',
    'FixtureLoan-C-Preserve-001',
    'FixtureLoan-C-Unnamed',
  ]);
});
it('blocks an identical duplicate even at the final save boundary without sending HTTP', async () => {
  const one = { ...question(), expectedPreviousRevisionId: null };
  const fetcher = vi.fn();
  const client = new InsightClient('http://insight.test', 'test-secret', fetcher);
  await expect(
    client.saveAnalysis({ ...request, drafts: [one, { ...one, effectKey: 'another-key' }] }),
  ).rejects.toMatchObject({ status: 422, code: 'DUPLICATE_BUSINESS_QUESTION' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('detects event-only qualitative collisions after period and basis normalization', async () => {
  const one = question();
  const fetcher = vi.fn();
  const client = new InsightClient('http://insight.test', 'test-secret', fetcher);
  await expect(
    client.prepare(request, [
      one,
      {
        ...one,
        effectKey: 'different-prose-id',
        question: {
          ...one.question,
          targetPeriod: '2027',
          baselinePeriod: 'previous:2026',
          basis: null,
        },
      },
    ]),
  ).rejects.toMatchObject({ code: 'DUPLICATE_BUSINESS_QUESTION' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('treats missing, null and unknown monetary basis as the same persisted identity', async () => {
  const one = {
    ...question(),
    question: {
      mechanism: 'financing_cost' as const,
      frame: 'absolute' as const,
      unit: 'RUB',
      targetPeriod: '2027',
      baselinePeriod: null,
    },
  };
  const fetcher = vi.fn();
  const client = new InsightClient('http://insight.test', 'test-secret', fetcher);
  for (const basis of [null, 'unknown'] as const)
    await expect(
      client.prepare(request, [one, { ...one, question: { ...one.question, basis } }]),
    ).rejects.toMatchObject({ code: 'DUPLICATE_BUSINESS_QUESTION' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('preserves genuinely distinct objects, mechanisms, frames, units, periods and bases', async () => {
  const one = question('FixtureLoan-001');
  const monetary = {
    ...one,
    question: {
      ...one.question,
      frame: 'absolute' as const,
      unit: 'RUB',
      targetPeriod: '2027',
      basis: 'contract_total' as const,
    },
  };
  const drafts = [
    one,
    { ...one, literalObjectRef: 'FixtureLoan-002' },
    { ...one, question: { ...one.question, mechanism: 'refinancing_access' as const } },
    monetary,
    { ...monetary, question: { ...monetary.question, targetPeriod: '2028' } },
    { ...monetary, question: { ...monetary.question, unit: 'USD' } },
    { ...monetary, question: { ...monetary.question, basis: 'annual_run_rate' as const } },
    {
      ...monetary,
      question: {
        ...monetary.question,
        frame: 'budget_delta' as const,
        baselinePeriod: 'budget:2027',
      },
    },
    {
      ...monetary,
      question: {
        ...monetary.question,
        frame: 'budget_delta' as const,
        baselinePeriod: 'budget:2026',
      },
    },
  ].map((draft, index) => ({
    ...draft,
    effectKey: `draft-${index}`,
    expectedPreviousRevisionId: null,
  }));
  const fetcher = vi.fn(async () => Response.json({ drafts }));
  const client = new InsightClient('http://insight.test', 'test-secret', fetcher);
  expect(await client.prepare(request, drafts)).toEqual(drafts);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('ignores ordinary English contract prose and preserves existing Russian literal handles', () => {
  const prose = {
    ...context.news,
    text: 'SYNTHETIC CONTRACT ONLY. A loan has unknown terms. Agreement with another party. Договор РЕНТА. Договор RENT-42.',
  };
  expect(objectCatalog([prose], request.companyId).map((object) => object.literal)).toEqual([
    `company:${request.companyId}`,
    'РЕНТА',
    'RENT-42',
  ]);
});

it('matches the exact canonical key rejected by the deployed Insight policy', () => {
  expect(
    businessQuestionKey('company:d7aeac1f-432f-47bd-a826-0d55fbb3fccf', question().question),
  ).toBe('question-a8a3a416f5d991ba202c12af26dd8804df4e28f5');
});
it('does not create identifiers by matching a loan or contract label inside another word', () => {
  const prose = {
    ...context.news,
    text: 'loanFixtureLoan-C-Unnamed and contractFixture-009 are plain joined words, not labelled identifiers.',
  };
  expect(objectCatalog([prose], request.companyId)).toEqual([
    { handle: 'o0', literal: `company:${request.companyId}`, sourceHandles: [] },
  ]);
});
