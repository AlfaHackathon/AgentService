import * as v from 'valibot';
import { validateEvidenceDependencies } from '../../contracts/evidence-dependencies.ts';
import { newsPlanSchema } from '../../contracts/flow.ts';
import { InsightClient } from '../../retrieval/insight-client.ts';
import { sourceKey } from '../../retrieval/source-catalog.ts';
import { companyResultSchema, planResultSchema, roleResultSchema } from '../agent-schemas.ts';
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
  const schema = companyResultSchema(
    task.serviceTools ? evidence.objects.map((o) => o.handle) : task.objectHandles,
    task.serviceTools ? evidence.sources.map((_, i) => `s${i}`) : task.sourceHandles,
    task.questionHandles,
  );
  useResultTool('submit_news_analysis', schema, async (data) => {
    const drafts = v.parse(schema, data).drafts;
    for (const draft of drafts) {
      validateEvidenceDependencies(draft.assessment, draft.impact.evidenceStatus);
      for (const condition of draft.assessment.conditions)
        if (
          condition.sourceHandles.some((handle) => !draft.sourceHandles.includes(handle)) ||
          (condition.status !== 'unknown' && !condition.sourceHandles.length)
        )
          throw new Error(
            'Every condition source must also be cited in draft.sourceHandles; supported or contradicted conditions require evidence. Correct citations before submitting.',
          );
      if (task.serviceTools?.kind === 'company') {
        if (
          typeof draft.question !== 'string' &&
          task.serviceTools.request.mechanisms?.length &&
          !task.serviceTools.request.mechanisms.includes(draft.question.mechanism)
        )
          throw new Error(
            `Question mechanism is outside the requested scope. Use only: ${task.serviceTools.request.mechanisms.join(', ')}. Correct the result before submitting.`,
          );
        const app = draft.assessment.applicability;
        if (app?.sourceHandles.some((h) => !draft.sourceHandles.includes(h)))
          throw new Error('Applicability evidence must also be cited in draft.sourceHandles.');
      }
    }
    if (drafts.length && task.serviceTools?.kind === 'company' && process.env.INSIGHT_SERVICE_URL) {
      const sourceRef = (handle: string) => {
        const source = evidence.sources[Number(handle.slice(1))];
        if (!source) throw new Error('Unknown source handle');
        return {
          materialId: source.materialId,
          versionId: source.versionId,
          contentHash: source.contentHash,
        };
      };
      const client = new InsightClient(
        process.env.INSIGHT_SERVICE_URL,
        process.env.INTERNAL_SECRET ?? '',
      );
      client.http.deadlineAt = task.serviceTools.deadlineAt;
      await client.validateApplicability({
        companyId: task.serviceTools.request.companyId,
        asOf: task.serviceTools.request.asOf,
        candidates: drafts.map((draft) => ({
          assessment: {
            unknowns: draft.assessment.unknowns,
            conditions: draft.assessment.conditions.map(({ sourceHandles, ...condition }) => ({
              ...condition,
              sourceRefs: sourceHandles.map(sourceRef),
            })),
            ...(draft.assessment.applicability
              ? {
                  applicability: {
                    status: draft.assessment.applicability.status,
                    basis: draft.assessment.applicability.basis,
                    explanation: draft.assessment.applicability.explanation,
                    assumptions: draft.assessment.applicability.assumptions,
                    sourceRefs: draft.assessment.applicability.sourceHandles.map(sourceRef),
                  },
                }
              : {}),
          },
          evidenceStatus: draft.impact.evidenceStatus,
          hasCalculation: !!draft.calculation,
        })),
      });
    }
  });
  return;
}

export function useRoleTools(task: AgentTask) {
  useServiceTools(task.serviceTools);
  useResultTool('project_role_actions', roleResultSchema);
  return;
}
