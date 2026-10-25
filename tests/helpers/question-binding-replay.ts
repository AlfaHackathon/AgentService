import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  analysisRequestSchema,
  contextBundleSchema,
} from '../../src/news-analysis/contracts/analysis.ts';
import { questionSchema } from '../../src/news-analysis/contracts/questions.ts';
import type { CompanyResultScope } from '../../src/news-analysis/reasoning/company-result.ts';

export const questionBindingReplay = z
  .object({
    request: analysisRequestSchema,
    context: contextBundleSchema,
    objectCatalog: z.array(
      z.object({
        handle: z.string(),
        literal: z.string(),
        sourceHandles: z.array(z.string()),
      }),
    ),
    previousQuestions: z.array(
      z.object({
        handle: z.string(),
        literal: z.string(),
        question: questionSchema,
        economicObjectId: z.string().nullable().optional(),
      }),
    ),
    rawResult: z.object({ drafts: z.tuple([z.record(z.string(), z.unknown())]) }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../fixtures/fullflow-question-object-binding.json', import.meta.url),
        'utf8',
      ),
    ),
  );

export function questionBindingScope(): CompanyResultScope {
  const replay = structuredClone(questionBindingReplay);
  return {
    companyId: replay.request.companyId,
    asOf: replay.request.asOf,
    sources: [replay.context.news, ...replay.context.materials],
    objects: replay.objectCatalog,
    questions: replay.previousQuestions.map(({ economicObjectId, ...question }) =>
      economicObjectId === undefined ? question : { ...question, economicObjectId },
    ),
  };
}

export function newLoanQuestionResult() {
  const question = questionBindingReplay.previousQuestions.find((q) => q.handle === 'q1');
  if (!question) throw new Error('Missing captured q1 binding');
  return {
    drafts: [
      {
        ...structuredClone(questionBindingReplay.rawResult.drafts[0]),
        question: structuredClone(question.question),
      },
    ],
  };
}
