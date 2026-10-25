import { createHash } from 'node:crypto';
import type { EffectDraft } from './analysis.ts';
import { NewsAnalysisError } from './errors.ts';

type QuestionIdentity = NonNullable<EffectDraft['question']>;

// Keep field order/defaults aligned with Insight QuestionIdentityPolicy.QuestionKey.
// Event-only qualitative questions are timeless; prose and sources are not identity.
export function businessQuestionKey(literal: string, question: QuestionIdentity): string {
  const qualitative = question.frame === 'event_only' && question.unit === 'qualitative';
  const identity = [
    literal,
    question.mechanism,
    question.frame,
    question.unit,
    qualitative ? 'unknown' : question.targetPeriod,
    qualitative ? '' : (question.baselinePeriod ?? ''),
    qualitative ? 'qualitative' : (question.basis ?? 'unknown'),
  ].join('\u001f');
  return `question-${createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 40)}`;
}

export function validateUniqueBusinessQuestions(drafts: EffectDraft[]): void {
  const seen = new Map<string, number>();
  for (const [index, draft] of drafts.entries()) {
    const key = draft.question
      ? businessQuestionKey(draft.literalObjectRef, draft.question)
      : draft.effectKey;
    const previous = seen.get(key);
    if (previous !== undefined)
      throw new NewsAnalysisError(
        422,
        'DUPLICATE_BUSINESS_QUESTION',
        `Drafts ${previous} and ${index} have the same canonical business question ${key}. Different conclusions, source refs or draft effect keys do not distinguish questions. For different obligations select their distinct documented literal objects from the object catalog. Consolidate only a genuinely shared question while preserving its evidence and unknowns. Do not invent objects or change mechanism, frame or period just to evade the collision. No drafts were saved.`,
      );
    seen.set(key, index);
  }
}
