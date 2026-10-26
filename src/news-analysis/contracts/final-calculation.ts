import type { EffectDraft } from './analysis.ts';
import { businessQuestionKey } from './business-questions.ts';
import { NewsAnalysisError } from './errors.ts';

// The proposal is an input to review, never a fallback calculation to persist.
// Match the exact typed question; prose, draft indexes and source overlap are not identity.
export function validateFinalCalculations(proposals: EffectDraft[], finals: EffectDraft[]): void {
  const calculated = new Set(
    proposals.flatMap((draft) =>
      draft.calculation && draft.question && draft.question.unit !== 'qualitative'
        ? [businessQuestionKey(draft.literalObjectRef, draft.question)]
        : [],
    ),
  );
  for (const draft of finals) {
    if (
      draft.calculation ||
      !draft.question ||
      !calculated.has(businessQuestionKey(draft.literalObjectRef, draft.question))
    )
      continue;
    const explicitUnknown =
      draft.status === 'unknown' &&
      draft.impact?.evidenceStatus === 'unknown' &&
      !!draft.assessment?.unknowns.some((unknown) => unknown.fact.trim().length > 0);
    if (explicitUnknown) continue;
    throw new NewsAnalysisError(
      422,
      'FINAL_CALCULATION_REQUIRED',
      'Final review retained a previously calculated quantitative question without its calculation. Submit the complete, source-grounded final expression, unit and period; the proposal is not copied automatically. If the effect cannot be assessed, explicitly use status=unknown and impact.evidenceStatus=unknown with structured missing facts and an honest qualitative conclusion, or withdraw the preliminary draft. Do not retain an asserted computed amount without a calculation or change the question identity merely to evade validation. Company importance may remain null. No drafts were saved.',
    );
  }
}
