import * as v from 'valibot';
import { NewsAnalysisError } from '../../contracts/errors.ts';
import { validateEvidenceDependencies } from '../../contracts/evidence-dependencies.ts';
import { newsPlanSchema } from '../../contracts/flow.ts';
import { economicObjectCatalog } from '../../retrieval/economic-objects.ts';
import { InsightClient } from '../../retrieval/insight-client.ts';
import { sourceKey } from '../../retrieval/source-catalog.ts';
import { companyResultSchema, planResultSchema, roleResultSchema } from '../agent-schemas.ts';
import { resolveCompanyResult } from '../company-result.ts';
import { useServiceTools } from '../service-tools.ts';
import { type AgentTask, useResultTool } from './result.ts';

export function useNewsPlannerTools(task: AgentTask) {
  const evidence = useServiceTools(task.serviceTools);
  useResultTool('plan_news_insights', planResultSchema, (data) => {
    if (task.serviceTools?.kind !== 'planner') return;
    const trigger = task.serviceTools.sources[0];
    const allowed = new Set(evidence.sources.map(sourceKey));
    const plan = newsPlanSchema.parse(data);
    if (
      !trigger ||
      plan.generalInsights.some(
        (insight) =>
          !insight.sourceRefs.some((ref) => sourceKey(ref) === sourceKey(trigger)) ||
          insight.sourceRefs.some((ref) => !allowed.has(sourceKey(ref))),
      )
    )
      throw new Error(
        'Every general insight must cite the triggering news and only exact sources in the permitted catalog. Correct sourceRefs before submitting.',
      );
  });
  return;
}

export function useCompanyTools(task: AgentTask) {
  const evidence = useServiceTools(task.serviceTools);
  const scope = task.companyScope && {
    ...task.companyScope,
    sources: task.serviceTools ? evidence.sources : task.companyScope.sources,
    objects: task.serviceTools ? evidence.objects : task.companyScope.objects,
  };
  const schema = companyResultSchema(
    scope ? scope.objects.map((o) => o.handle) : task.objectHandles,
    scope ? scope.sources.map((_, i) => `s${i}`) : task.sourceHandles,
    task.questionHandles,
    scope
      ? economicObjectCatalog(scope.sources, scope.companyId, scope.asOf).map((o) => o.handle)
      : [],
  );
  useResultTool(
    'submit_news_analysis',
    schema,
    async (data) => {
      try {
        const drafts = v.parse(schema, data).drafts;
        for (const draft of drafts) {
          validateEvidenceDependencies(draft.assessment, draft.impact.evidenceStatus);
          if (
            task.serviceTools?.kind === 'company' &&
            typeof draft.question !== 'string' &&
            task.serviceTools.request.mechanisms?.length &&
            !task.serviceTools.request.mechanisms.includes(draft.question.mechanism)
          )
            throw new NewsAnalysisError(
              422,
              'QUESTION_SCOPE',
              'Question mechanism is outside the requested scope. Use only the requested mechanisms.',
            );
        }
        if (!scope) {
          if (drafts.length)
            throw new NewsAnalysisError(
              422,
              'COMPANY_SCOPE',
              'A trusted company evidence scope is required.',
            );
          return;
        }
        const resolved = resolveCompanyResult(data, scope);
        if (
          resolved.length &&
          task.serviceTools?.kind === 'company' &&
          process.env.INSIGHT_SERVICE_URL
        ) {
          const client = new InsightClient(
            process.env.INSIGHT_SERVICE_URL,
            process.env.INTERNAL_SECRET ?? '',
          );
          client.http.deadlineAt = task.serviceTools.deadlineAt;
          // Pure validation/canonical preparation. A tool acceptance is not a saved receipt.
          const qualitative = resolved.filter((draft) => !draft.calculation);
          if (qualitative.length)
            await client.validateApplicability({
              companyId: scope.companyId,
              asOf: scope.asOf,
              candidates: qualitative.map((draft) => ({
                assessment: draft.assessment,
                evidenceStatus: draft.impact?.evidenceStatus ?? 'unknown',
                hasCalculation: false,
              })),
            });
          await client.prepare(task.serviceTools.request, resolved);
        }
      } catch (error) {
        if (!(error instanceof NewsAnalysisError) || error.status !== 422) throw error;
        throw new Error(
          JSON.stringify({
            status: 'invalid',
            code: error.code === 'UPSTREAM_ERROR' ? 'INSIGHT_DRAFT_VALIDATION' : error.code,
            httpStatus: 422,
            message:
              error.code === 'UPSTREAM_ERROR'
                ? 'Insight rejected this draft. Recheck the documented object selector, exact own-source citations, frame and budget baseline; preserve qualitative unknown if evidence is missing.'
                : error.message,
            maximumCorrections: 1,
            saved: false,
          }),
        );
      }
    },
    undefined,
    2,
  );
}

export function useRoleTools(task: AgentTask) {
  useServiceTools(task.serviceTools);
  useResultTool('project_role_actions', roleResultSchema);
  return;
}
