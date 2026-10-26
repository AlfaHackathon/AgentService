import type { EffectDraft } from './analysis.ts';
import { NewsAnalysisError } from './errors.ts';

// Same cross-field contract as Insight's final write normalizer. Representations
// must match exactly; this does not infer dates, convert units or alter history.
export function validateCalculationQuestion(draft: Pick<EffectDraft, 'question' | 'calculation'>) {
  const { question, calculation } = draft;
  if (!question || !calculation) return;
  if (
    calculation.unit !== question.unit ||
    calculation.period !== question.targetPeriod ||
    question.targetPeriod === 'unknown' ||
    (question.frame === 'budget_delta' && question.baselinePeriod === 'unknown')
  )
    throw new NewsAnalysisError(
      422,
      'CALCULATION_QUESTION_MISMATCH',
      `Calculation must exactly match a known question unit, target period and comparison baseline. ${JSON.stringify({ calculation: { unit: calculation.unit, period: calculation.period }, question: { unit: question.unit, targetPeriod: question.targetPeriod, frame: question.frame, baselinePeriod: question.baselinePeriod } })}. Recheck the cited source and submit an explicit grounded correction. Do not treat different period representations as equivalent or change an existing question's identity to obtain acceptance. If the required period or baseline is unknown, preserve the unknowns and omit the calculation. No draft was saved.`,
    );
}
