import type { z } from 'zod';
import type { assessmentSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import { type Source, sourceKey } from '../retrieval/source-catalog.ts';

export function validateApplicability(
  assessment: z.infer<typeof assessmentSchema> | undefined,
  evidence: string | undefined,
  hasCalculation: boolean,
  sources: Source[],
  companyId: string,
) {
  evidence ??= 'unknown';
  const app = assessment?.applicability;
  const needsExposure = ['supported', 'conditional', 'unaffected'].includes(evidence ?? '');
  if (needsExposure || app?.status === 'established' || app?.status === 'excluded') {
    const ownEvidence = app?.sourceRefs.some((ref) =>
      sources.some(
        (s) =>
          sourceKey(s) === sourceKey(ref) &&
          s.kind === 'company' &&
          s.companyIds.includes(companyId) &&
          s.sourceId !== 'provided-bank-csv',
      ),
    );
    if (
      app?.basis !== 'documented_exposure' ||
      !ownEvidence ||
      (['supported', 'conditional'].includes(evidence ?? '') && app.status !== 'established') ||
      (evidence === 'unaffected' && !['established', 'excluded'].includes(app.status))
    )
      throw new NewsAnalysisError(
        422,
        'APPLICABILITY_NOT_ESTABLISHED',
        'Company exposure requires a cited own documentary source. A CSV profile flag or public macro source is insufficient; preserve unknown.',
      );
  }
  if (evidence === 'conditional' && !app?.assumptions.length)
    throw new NewsAnalysisError(
      422,
      'SCENARIO_ASSUMPTIONS_REQUIRED',
      'Conditional requires explicit scenario assumptions on established company exposure.',
    );
  if (
    evidence === 'supported' &&
    ((app?.assumptions.length ?? 0) ||
      assessment?.unknowns.length ||
      assessment?.conditions.some((c) => c.status !== 'supported'))
  )
    throw new NewsAnalysisError(
      422,
      'UNRESOLVED_SUPPORTED_CLAIM',
      'A supported consequence cannot retain unresolved required inputs or scenario assumptions.',
    );
  if (evidence === 'unknown' && hasCalculation)
    throw new NewsAnalysisError(
      422,
      'UNKNOWN_CALCULATION',
      'Unknown impact cannot be represented by a monetary calculation or zero.',
    );
}
