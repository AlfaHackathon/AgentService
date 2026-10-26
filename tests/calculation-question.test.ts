import { expect, it } from 'vitest';
import { draftSchema } from '../src/news-analysis/contracts/analysis.ts';
import { validateCalculationQuestion } from '../src/news-analysis/contracts/calculation-question.ts';

const draft = () =>
  draftSchema.parse({
    effectKey: 'synthetic',
    literalObjectRef: 'synthetic-loan',
    conclusion: 'Synthetic comparison',
    status: 'announced',
    sourceRefs: [{ materialId: 'synthetic', versionId: 'v1', contentHash: 'a'.repeat(64) }],
    question: {
      mechanism: 'financing_cost',
      frame: 'event_only',
      unit: 'RUB',
      targetPeriod: '2027',
      baselinePeriod: null,
    },
    calculation: { expression: { kind: 'value', value: '1' }, unit: 'RUB', period: '2027' },
  });

it.each(['unit', 'period', 'unknown_period', 'unknown_budget_baseline'] as const)(
  'rejects %s before accepting a calculation without mutating the draft',
  (defect) => {
    const value = draft();
    if (!value.question || !value.calculation) throw new Error('Missing fixture calculation');
    if (defect === 'unit') value.calculation.unit = 'USD';
    if (defect === 'period') value.calculation.period = '2027-01-01/2028-01-01';
    if (defect === 'unknown_period') {
      value.question.targetPeriod = 'unknown';
      value.calculation.period = 'unknown';
    }
    if (defect === 'unknown_budget_baseline') {
      value.question.frame = 'budget_delta';
      value.question.baselinePeriod = 'unknown';
    }
    const before = structuredClone(value);
    expect(() => validateCalculationQuestion(value)).toThrowError(
      expect.objectContaining({ status: 422, code: 'CALCULATION_QUESTION_MISMATCH' }),
    );
    expect(value).toEqual(before);
  },
);

it('keeps a valid exact year, null event baseline and calculation unchanged', () => {
  const value = draft();
  const before = structuredClone(value);
  validateCalculationQuestion(value);
  expect(value).toEqual(before);
});

it('preserves unknown qualitative drafts and legacy calculations without a canonical question', () => {
  const value = draft();
  if (!value.question) throw new Error('Missing fixture question');
  const { calculation, ...qualitative } = value;
  qualitative.question = {
    ...value.question,
    unit: 'qualitative',
    targetPeriod: 'unknown',
    baselinePeriod: null,
  };
  validateCalculationQuestion(qualitative);
  expect(qualitative.question).toMatchObject({ targetPeriod: 'unknown', baselinePeriod: null });
  expect(qualitative).not.toHaveProperty('calculation');
  validateCalculationQuestion({ calculation });
});
