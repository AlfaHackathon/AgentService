import { expect, it } from 'vitest';
import { businessQuestionKey } from '../src/news-analysis/contracts/business-questions.ts';
import { resolveCompanyResult } from '../src/news-analysis/reasoning/company-result.ts';
import {
  newLoanQuestionResult,
  questionBindingReplay,
  questionBindingScope,
} from './helpers/question-binding-replay.ts';

it('reports the captured loan o1 plus company question q1 mismatch as a correctable binding error', () => {
  const scope = questionBindingScope();
  const before = structuredClone(scope.questions);
  expect(() => resolveCompanyResult(questionBindingReplay.rawResult, scope)).toThrowError(
    expect.objectContaining({ status: 422, code: 'QUESTION_OBJECT_BINDING' }),
  );
  expect(scope.questions).toEqual(before);
});

it('reuses an existing question only on its original company object without changing history', () => {
  const scope = questionBindingScope();
  const before = structuredClone(scope.questions);
  const response = structuredClone(questionBindingReplay.rawResult);
  response.drafts[0].objectHandle = 'o0';
  const [draft] = resolveCompanyResult(response, scope);
  const previous = scope.questions.find((q) => q.handle === 'q1');
  expect(draft?.literalObjectRef).toBe(previous?.literal);
  expect(draft?.question).toEqual(previous?.question);
  expect(scope.questions).toEqual(before);
});

it('creates a separate canonical question for the new loan while preserving the company question', () => {
  const scope = questionBindingScope();
  const before = structuredClone(scope.questions);
  const [draft] = resolveCompanyResult(newLoanQuestionResult(), scope);
  const previous = scope.questions.find((q) => q.handle === 'q1');
  expect(draft?.literalObjectRef).toBe('FixtureLoan-E-001');
  expect(draft?.question).toEqual(previous?.question);
  if (!draft?.question || !previous) throw new Error('Missing question identity');
  expect(businessQuestionKey(draft.literalObjectRef, draft.question)).not.toBe(
    businessQuestionKey(previous.literal, previous.question),
  );
  expect(businessQuestionKey(previous.literal, previous.question)).toBe(
    'question-72f75eda9d323c1359c1610dfc381a7ff9c62fd0',
  );
  expect(scope.questions).toEqual(before);
});
