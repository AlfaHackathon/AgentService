import { expect, it } from 'vitest';
import { validateApplicability } from '../src/news-analysis/application/applicability.ts';
import { type EffectDraft, materialSchema } from '../src/news-analysis/contracts/analysis.ts';
import {
  normalizeQuestion,
  questionKey,
  questionSchema,
} from '../src/news-analysis/contracts/questions.ts';

const company = '11111111-1111-4111-8111-111111111111';
const source = materialSchema.parse({
  materialId: 'profile',
  versionId: '1',
  sourceId: 'provided-bank-csv',
  kind: 'company',
  title: 'Profile',
  text: 'Product flag only',
  knownAt: '2026-10-23T08:00:00Z',
  companyIds: [company],
  bankProfileIds: [],
  contentHash: 'a'.repeat(64),
});
const assessment: NonNullable<EffectDraft['assessment']> = {
  conditions: [],
  unknowns: [],
  applicability: {
    status: 'established',
    basis: 'documented_exposure',
    explanation: 'Claimed exposure',
    sourceRefs: [
      {
        materialId: source.materialId,
        versionId: source.versionId,
        contentHash: source.contentHash,
      },
    ],
    assumptions: ['Future index scenario'],
  },
};

it('keeps one qualitative question across publication dates without merging monetary windows or mechanisms', () => {
  const q = questionSchema.parse({
    mechanism: 'financing_cost',
    frame: 'event_only',
    unit: 'qualitative',
    targetPeriod: '2026-09-11',
    baselinePeriod: null,
  });
  expect(questionKey('company:x', q)).toBe(
    questionKey('company:x', { ...q, targetPeriod: '2026-10-23', basis: 'monthly_run_rate' }),
  );
  expect(normalizeQuestion(q).targetPeriod).toBe('unknown');
  expect(questionKey('company:x', q)).not.toBe(
    questionKey('company:x', { ...q, mechanism: 'demand' }),
  );
  const monetary = { ...q, frame: 'absolute' as const, unit: 'RUB', targetPeriod: '2026-11' };
  expect(questionKey('loan:A', monetary)).not.toBe(
    questionKey('loan:A', { ...monetary, targetPeriod: '2026-12' }),
  );
});

it('rejects a profile flag, public macro and foreign scope as established company exposure', () => {
  expect(() => validateApplicability(assessment, 'conditional', false, [source], company)).toThrow(
    'preserve unknown',
  );
  const document = { ...source, sourceId: 'provided-document' };
  expect(() =>
    validateApplicability(
      assessment,
      'conditional',
      false,
      [document],
      '22222222-2222-4222-8222-222222222222',
    ),
  ).toThrow();
  expect(() =>
    validateApplicability(
      assessment,
      'conditional',
      false,
      [{ ...document, kind: 'market', companyIds: [] }],
      company,
    ),
  ).toThrow();
  expect(() =>
    validateApplicability(assessment, 'conditional', false, [document], company),
  ).not.toThrow();
});

it('requires an explicit scenario and never turns unknown into a zero calculation', () => {
  const document = { ...source, sourceId: 'provided-document' };
  const app = assessment.applicability;
  if (!app) throw new Error('Missing fixture applicability');
  expect(() =>
    validateApplicability(
      { ...assessment, applicability: { ...app, assumptions: [] } },
      'conditional',
      false,
      [document],
      company,
    ),
  ).toThrow('scenario');
  expect(() => validateApplicability(undefined, 'unknown', false, [source], company)).not.toThrow();
  expect(() => validateApplicability(undefined, 'unknown', true, [source], company)).toThrow(
    'zero',
  );
});
