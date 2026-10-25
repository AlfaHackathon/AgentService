import type { EffectDraft } from './analysis.ts';
import { NewsAnalysisError } from './errors.ts';

type Ref = { materialId: string; versionId: string; contentHash: string };
const same = (a: Ref, b: Ref) =>
  a.materialId === b.materialId && a.versionId === b.versionId && a.contentHash === b.contentHash;
export function validateCompanyImportanceEvidence(
  draft: Pick<EffectDraft, 'companyImportance' | 'sourceRefs' | 'impact'>,
  ownSources: Ref[],
) {
  const rating = draft.companyImportance;
  if (!rating) return;
  if (draft.impact !== undefined && draft.impact.importance !== (rating.score ?? 0))
    throw new NewsAnalysisError(
      422,
      'COMPANY_IMPORTANCE_CONFLICT',
      'With companyImportance present, the legacy importance component must equal score or zero for null.',
    );
  if (
    rating.evidenceRefs.some((r) => !draft.sourceRefs.some((s) => same(r, s))) ||
    (rating.score !== null && !rating.evidenceRefs.some((r) => ownSources.some((s) => same(r, s))))
  )
    throw new NewsAnalysisError(
      422,
      'UNBOUND_COMPANY_IMPORTANCE',
      'Company importance must cite this draft evidence and an own-company source; otherwise keep score null.',
    );
}
