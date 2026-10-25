import { expect, it } from 'vitest';
import { z } from 'zod';
import { validateReferences } from '../src/news-analysis/application/draft-validation.ts';
import {
  companyImportanceSchema,
  draftSchema,
  effectsResponseSchema,
} from '../src/news-analysis/contracts/analysis.ts';
import { resolveCompanyResult } from '../src/news-analysis/reasoning/company-result.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const now = '2026-10-25T00:00:00Z';
const source = (materialId: string, kind: 'news' | 'company', companyIds: string[]) => ({
  materialId,
  versionId: 'v1',
  contentHash: 'a'.repeat(64),
  sourceId: 'synthetic',
  kind,
  title: materialId,
  text: 'Synthetic company facts.',
  knownAt: now,
  companyIds,
  bankProfileIds: [],
});
const news = source('news', 'news', []);
const own = source('own', 'company', [companyId]);
const ref = ({ materialId, versionId, contentHash }: typeof news) => ({
  materialId,
  versionId,
  contentHash,
});
const draft = {
  effectKey: 'q',
  literalObjectRef: `company:${companyId}`,
  conclusion: 'Synthetic consequence',
  status: 'unknown',
  sourceRefs: [ref(news), ref(own)],
};
const importance = {
  score: 4,
  rationale: 'An explicitly documented company dependency requires prompt review.',
  evidenceRefs: [ref(own)],
};
const context = {
  news,
  materials: [own],
  coverage: {
    complete: true,
    materialCount: 2,
    companyMaterialCount: 1,
    marketMaterialCount: 0,
    previousNewsVersionCount: 0,
    characters: 100,
    asOf: now,
  },
};
const native = (score: number | null, evidenceSourceHandles = ['s1']) => ({
  drafts: [
    {
      objectHandle: 'o0',
      assessment: { conditions: [], unknowns: [] },
      question: {
        mechanism: 'liquidity',
        frame: 'event_only',
        unit: 'qualitative',
        targetPeriod: '2026-11',
        baselinePeriod: null,
        basis: 'qualitative',
      },
      conclusion: 'Synthetic consequence',
      status: 'unknown',
      impact: {
        metric: 'other',
        amountBasis: 'qualitative',
        economicObjectHandle: null,
        evidenceStatus: 'unknown',
        importance: 0,
        urgency: 0,
        novelty: 0,
      },
      sourceHandles: ['s0', 's1'],
      companyImportance: {
        score,
        rationale:
          score === null ? 'Company materiality cannot be established.' : importance.rationale,
        evidenceSourceHandles,
      },
    },
  ],
});
const scope = {
  companyId,
  asOf: now,
  sources: [news, own],
  objects: [{ handle: 'o0', literal: `company:${companyId}`, sourceHandles: [] }],
  questions: [],
};

it('retains a grounded company assessment separately from legacy impact ranking', () => {
  const parsed = draftSchema.parse({ ...draft, companyImportance: importance });
  expect(parsed).toMatchObject({ companyImportance: importance });
  validateReferences([parsed], context);
});
it.each([0, 6, 2.5])('rejects score %s rather than treating it as a 1..5 assessment', (score) => {
  expect(
    draftSchema.safeParse({ ...draft, companyImportance: { ...importance, score } }).success,
  ).toBe(false);
});
it('keeps insufficient evidence as null, not low importance', () => {
  const parsed = draftSchema.parse({
    ...draft,
    companyImportance: {
      score: null,
      rationale: 'Missing company exposure and materiality.',
      evidenceRefs: [],
    },
  });
  expect(parsed).toHaveProperty('companyImportance.score', null);
  validateReferences([parsed], context);
});
it('rejects empty rationale and unbound or public-only rating evidence', () => {
  expect(
    draftSchema.safeParse({ ...draft, companyImportance: { ...importance, rationale: ' ' } })
      .success,
  ).toBe(false);
  expect(() =>
    validateReferences(
      [
        draftSchema.parse({
          ...draft,
          companyImportance: {
            ...importance,
            evidenceRefs: [{ ...ref(own), versionId: 'foreign' }],
          },
        }),
      ],
      context,
    ),
  ).toThrow();
  expect(() =>
    validateReferences(
      [
        draftSchema.parse({
          ...draft,
          companyImportance: { ...importance, evidenceRefs: [ref(news)] },
        }),
      ],
      context,
    ),
  ).toThrow();
});
it('uses the new assessment as the single authority for the legacy compatibility component', () => {
  const result = resolveCompanyResult(native(4), scope)[0];
  expect(result).toMatchObject({ companyImportance: importance, impact: { importance: 4 } });
  expect(() => resolveCompanyResult(native(4, ['s0']), scope)).toThrow();
});
it('reads old and new revision DTOs without fabricating a historical assessment', () => {
  const revision = {
    revisionId: 'r1',
    previousRevisionId: null,
    newsVersionId: 'v1',
    asOf: now,
    createdAt: now,
    conclusion: 'Stored',
    status: 'unknown',
    sourceRefs: [ref(news)],
    impact: null,
  };
  const effects = (currentRevision: object) => ({
    effects: [
      {
        effectId: 'e1',
        effectKey: 'q',
        companyId,
        bankProfileId: null,
        newsMaterialId: 'news',
        literalObjectRef: 'company',
        currentRevision,
        history: [currentRevision],
      },
    ],
  });
  const old = effectsResponseSchema.parse(effects(revision)).effects[0];
  expect(old?.currentRevision).not.toHaveProperty('companyImportance');
  const current = effectsResponseSchema.parse(
    effects({ ...revision, companyImportance: importance }),
  ).effects[0];
  expect(current?.currentRevision).toMatchObject({ companyImportance: importance });
});

it('does not convert old zero to null and uses zero only as compatibility weight for a new null assessment', () => {
  const legacy = {
    ...draft,
    impact: {
      metric: 'other',
      amountBasis: 'qualitative',
      economicObjectId: null,
      evidenceStatus: 'unknown' as const,
      importance: 0,
      urgency: 0,
      novelty: 0,
    },
  };
  expect(draftSchema.parse(legacy)).not.toHaveProperty('companyImportance');
  const current = resolveCompanyResult(native(null, []), scope)[0];
  expect(current).toMatchObject({ companyImportance: { score: null }, impact: { importance: 0 } });
  expect(() =>
    validateReferences([draftSchema.parse({ ...legacy, companyImportance: importance })], context),
  ).toThrow();
});

it('exposes nullable 1..5 bounds and rationale in the schema used by OpenAPI', () => {
  const schema = z.toJSONSchema(companyImportanceSchema);
  expect(JSON.stringify(schema)).toContain('"minimum":1');
  expect(JSON.stringify(schema)).toContain('"maximum":5');
  expect(schema.required).toEqual(expect.arrayContaining(['score', 'rationale', 'evidenceRefs']));
});
