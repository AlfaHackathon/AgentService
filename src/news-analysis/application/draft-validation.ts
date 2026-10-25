import type { EffectDraft } from '../contracts/analysis.ts';
import { validateCompanyImportanceEvidence } from '../contracts/company-importance.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import { validateEvidenceDependencies } from '../contracts/evidence-dependencies.ts';
import type { ContextClient } from '../retrieval/context-client.ts';
export function sourceKey(source: { materialId: string; versionId: string; contentHash: string }) {
  return JSON.stringify([source.materialId, source.versionId, source.contentHash]);
}

export function validateReferences(
  drafts: EffectDraft[],
  context: Awaited<ReturnType<ContextClient['getContext']>>,
) {
  const available = new Set([context.news, ...context.materials].map(sourceKey));
  const currentNews = sourceKey(context.news);
  for (const draft of drafts) {
    validateCompanyImportanceEvidence(
      draft,
      context.materials.filter((s) => s.kind === 'company' && s.companyIds.length > 0),
    );
    validateEvidenceDependencies(draft.assessment, draft.impact?.evidenceStatus);
    if (
      draft.assessment?.applicability?.sourceRefs.some(
        (r) => !draft.sourceRefs.some((s) => sourceKey(s) === sourceKey(r)),
      )
    )
      throw new NewsAnalysisError(
        422,
        'UNBOUND_APPLICABILITY',
        'Applicability must cite this question sources',
      );
    if (
      draft.assessment?.conditions.some(
        (c) =>
          c.sourceRefs.some((r) => !draft.sourceRefs.some((s) => sourceKey(s) === sourceKey(r))) ||
          (c.status !== 'unknown' && !c.sourceRefs.length),
      )
    )
      throw new NewsAnalysisError(
        422,
        'UNBOUND_CONDITION',
        'Applicability evidence must be cited by this question',
      );
    if (
      !draft.sourceRefs.some((source) => sourceKey(source) === currentNews) ||
      draft.sourceRefs.some((source) => !available.has(sourceKey(source)))
    )
      throw new NewsAnalysisError(
        422,
        'UNBOUND_SOURCE_REF',
        'Draft must cite the current news and only exact supplied source versions',
      );
  }
}
