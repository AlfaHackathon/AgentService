import * as v from 'valibot';
import { type EffectDraft, reasoningOutputSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import type { questionSchema } from '../contracts/questions.ts';
import { economicObjectCatalog, selectedEconomicObject } from '../retrieval/economic-objects.ts';
import type { ObjectBinding, Source } from '../retrieval/source-catalog.ts';
import { companyResultSchema } from './agent-schemas.ts';
import { parseArithmetic } from './arithmetic.ts';

export type CompanyResultScope = {
  companyId: string;
  asOf: string;
  sources: Source[];
  objects: ObjectBinding[];
  questions: {
    handle: string;
    literal: string;
    economicObjectId?: string | null;
    question: import('zod').infer<typeof questionSchema>;
  }[];
};

export function resolveCompanyResult(
  response: unknown,
  { sources, objects, questions, companyId, asOf }: CompanyResultScope,
): EffectDraft[] {
  const handles = sources.map((_, i) => `s${i}`);
  const economics = economicObjectCatalog(sources, companyId, asOf);
  const result = v.safeParse(
    companyResultSchema(
      objects.map((o) => o.handle),
      handles,
      questions.map((q) => q.handle),
      economics.map((e) => e.handle),
    ),
    response,
  );
  if (!result.success)
    throw new NewsAnalysisError(
      502,
      'INVALID_REASONING_RESULT',
      `Model returned invalid structured arguments: ${result.issues
        .map((i) => i.message)
        .slice(0, 8)
        .join(', ')}`,
    );
  try {
    const parsed = reasoningOutputSchema.parse({
      drafts: result.output.drafts.map(
        (
          {
            sourceHandles,
            calculation,
            objectHandle,
            assessment,
            impact,
            question: proposedQuestion,
            ...draft
          },
          draftIndex,
        ) => {
          const object = objects.find((o) => o.handle === objectHandle);
          if (
            !object ||
            (object.sourceHandles.length &&
              !object.sourceHandles.some((h) => sourceHandles.includes(h)))
          )
            throw new Error('Uncited object binding');
          const priorQuestion =
            typeof proposedQuestion === 'string'
              ? questions.find((q) => q.handle === proposedQuestion)
              : undefined;
          if (
            typeof proposedQuestion === 'string' &&
            (!priorQuestion || priorQuestion.literal !== object.literal)
          )
            throw new Error('Unbound question handle');
          const question =
            typeof proposedQuestion === 'string' ? priorQuestion?.question : proposedQuestion;
          if (!question) throw new Error('Missing question identity');
          const economicObjectId = selectedEconomicObject(
            impact.economicObjectHandle,
            economics,
            sourceHandles,
            assessment.applicability?.sourceHandles ?? [],
            !!calculation,
          );
          if (
            economicObjectId &&
            ((!object.literal.startsWith('company:') && object.literal !== economicObjectId) ||
              questions.some(
                (prior) =>
                  prior.literal === object.literal &&
                  questionIdentity(prior.question) === questionIdentity(question) &&
                  !!prior.economicObjectId &&
                  prior.economicObjectId !== economicObjectId,
              ))
          )
            throw new NewsAnalysisError(
              422,
              'ECONOMIC_OBJECT_IDENTITY',
              'The selected economic object must agree with the literal object and the existing question binding. Select the matching object/question; do not reassign another contract.',
            );
          return {
            ...draft,
            impact: {
              ...Object.fromEntries(
                Object.entries(impact).filter(([key]) => key !== 'economicObjectHandle'),
              ),
              economicObjectId,
            },
            question,
            literalObjectRef: object.literal,
            effectKey: `draft-${draftIndex}`,
            assessment: {
              ...assessment,
              ...(assessment.applicability
                ? {
                    applicability: {
                      status: assessment.applicability.status,
                      basis: assessment.applicability.basis,
                      explanation: assessment.applicability.explanation,
                      assumptions: assessment.applicability.assumptions,
                      sourceRefs: assessment.applicability.sourceHandles.map((h) => {
                        const source = sources[handles.indexOf(h)];
                        if (!source || !sourceHandles.includes(h))
                          throw new Error('Unbound applicability evidence');
                        return {
                          materialId: source.materialId,
                          versionId: source.versionId,
                          contentHash: source.contentHash,
                        };
                      }),
                    },
                  }
                : {}),
              conditions: assessment.conditions.map(
                ({ sourceHandles: conditionSources, ...condition }) => {
                  if (
                    conditionSources.some((h) => !sourceHandles.includes(h)) ||
                    (condition.status !== 'unknown' && !conditionSources.length)
                  )
                    throw new Error('Unbound condition evidence');
                  return {
                    ...condition,
                    sourceRefs: conditionSources.map((h) => {
                      const s = sources[handles.indexOf(h)];
                      if (!s) throw new Error('Unbound condition source');
                      return {
                        materialId: s.materialId,
                        versionId: s.versionId,
                        contentHash: s.contentHash,
                      };
                    }),
                  };
                },
              ),
            },
            sourceRefs: sourceHandles.map((h) => {
              const source = sources[handles.indexOf(h)];
              if (!source) throw new Error('Unknown source handle');
              return {
                materialId: source.materialId,
                versionId: source.versionId,
                contentHash: source.contentHash,
              };
            }),
            ...(calculation
              ? {
                  calculation: {
                    ...calculation,
                    expression: parseArithmetic(calculation.expression),
                  },
                }
              : {}),
          };
        },
      ),
    }).drafts;
    for (const draft of parsed) validateFinancialFrame(draft, sources);
    return parsed;
  } catch (error) {
    if (error instanceof NewsAnalysisError) throw error;
    throw new NewsAnalysisError(
      502,
      'INVALID_REASONING_RESULT',
      'Model returned an invalid arithmetic expression or source binding',
    );
  }
}

function validateFinancialFrame(draft: EffectDraft, sources: Source[]) {
  if (!draft.calculation || !draft.question) return;
  const q = draft.question;
  const delta = ['expense_delta', 'revenue_delta', 'cashflow_delta'].includes(
    draft.impact?.metric ?? '',
  );
  if (
    (q.frame === 'absolute' && delta) ||
    (q.frame !== 'budget_delta' && q.baselinePeriod?.startsWith('budget:'))
  )
    throw new NewsAnalysisError(
      422,
      'FINANCIAL_FRAME',
      'Use event_only for a contractual counterfactual delta, absolute for a level (for example absolute_expense), and budget_delta only against a documented budget. Do not relabel a delta as an absolute level.',
    );
  if (q.frame === 'budget_delta') {
    const budget = q.baselinePeriod;
    const own = draft.assessment?.applicability?.sourceRefs ?? [];
    const supported =
      budget?.startsWith('budget:') &&
      draft.assessment?.conditions.some(
        (c) =>
          c.status === 'supported' &&
          c.assertion === 'observed' &&
          c.predicate === 'budget_baseline' &&
          c.dependsOn?.length === 0 &&
          c.fact.includes(budget) &&
          c.fact.includes(draft.impact?.economicObjectId ?? '\0') &&
          sources.some(
            (s) =>
              s.kind === 'company' &&
              s.sourceId !== 'provided-bank-csv' &&
              s.text.includes(c.fact) &&
              own.some(
                (r) =>
                  r.materialId === s.materialId &&
                  r.versionId === s.versionId &&
                  r.contentHash === s.contentHash,
              ) &&
              c.sourceRefs.some(
                (r) =>
                  r.materialId === s.materialId &&
                  r.versionId === s.versionId &&
                  r.contentHash === s.contentHash,
              ),
          ),
      );
    if (!supported)
      throw new NewsAnalysisError(
        422,
        'BUDGET_EVIDENCE',
        'A budget delta needs an observed budget_baseline exact excerpt binding budget:<period> and the selected economic object in a cited own document. A contractual pre-event rate is not a budget. Use a justified event_only comparison, or preserve unknown without calculation.',
      );
  }
}

// Mirrors Insight QuestionIdentityPolicy: field order, qualitative normalization,
// and missing basis are part of the persisted identity, not model prose.
function questionIdentity(question: CompanyResultScope['questions'][number]['question']): string {
  const qualitative = question.frame === 'event_only' && question.unit === 'qualitative';
  return JSON.stringify([
    question.mechanism,
    question.frame,
    question.unit,
    qualitative ? 'unknown' : question.targetPeriod,
    qualitative ? null : question.baselinePeriod,
    qualitative ? 'qualitative' : (question.basis ?? 'unknown'),
  ]);
}
