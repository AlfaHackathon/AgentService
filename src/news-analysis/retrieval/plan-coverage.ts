import type { z } from 'zod';
import type { materialSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import type { NewsPlan, Segment } from '../contracts/flow.ts';
import { sourceKey } from './source-catalog.ts';
import { type SourceUnit, sourceUnits } from './source-units.ts';
export function validateSegmentPlan(
  plan: NewsPlan,
  segments: Segment[],
  news: z.infer<typeof materialSchema>,
  sources: z.infer<typeof materialSchema>[],
) {
  return validateSegmentPlanRefs(
    plan,
    segments.map((s) => s.key),
    news,
    sources,
    sourceUnits(sources),
  );
}
export function validateSegmentPlanRefs(
  plan: NewsPlan,
  segmentKeys: string[],
  news: { materialId: string; versionId: string; contentHash: string },
  sources: Array<{ materialId: string; versionId: string; contentHash: string }>,
  units: SourceUnit[],
) {
  const coverage = plan.sourceCoverage ?? [];
  const unitMap = new Map(units.map((unit) => [unit.unitId, unit]));
  if (
    !plan.sourceCoverage ||
    coverage.length !== units.length ||
    new Set(coverage.map((row) => row.unitId)).size !== units.length ||
    coverage.some((row) => {
      const unit = unitMap.get(row.unitId);
      return (
        !unit ||
        (row.disposition === 'used') !== row.insightIndexes.length > 0 ||
        row.insightIndexes.some(
          (i) =>
            !plan.generalInsights[i]?.sourceRefs.some(
              (ref) => sourceKey(ref) === sourceKey(unit.sourceRef),
            ),
        )
      );
    }) ||
    plan.generalInsights.some(
      (_insight, i) => !coverage.some((row) => row.insightIndexes.includes(i)),
    )
  )
    throw new NewsAnalysisError(
      422,
      'SOURCE_COVERAGE',
      `Account for every source unit exactly once. Used units need valid insight indexes citing that unit source; other dispositions need empty indexes and a reason. Every insight must be supported by a used unit. Correct sourceCoverage before submitting. Missing units: ${units
        .filter((u) => !coverage.some((r) => r.unitId === u.unitId))
        .map((u) => u.unitId)
        .join(', ')}. Invalid links: ${coverage
        .flatMap((row) => {
          const unit = unitMap.get(row.unitId);
          return row.insightIndexes
            .filter(
              (i) =>
                !unit ||
                !plan.generalInsights[i]?.sourceRefs.some(
                  (ref) => sourceKey(ref) === sourceKey(unit.sourceRef),
                ),
            )
            .map(
              (i) =>
                `${row.unitId} -> insight ${i} requires source ${unit?.sourceRef.materialId ?? 'unknown unit'}`,
            );
        })
        .join('; ')}.`,
    );
  const rows = plan.segmentCoverage ?? [];
  const keys = new Set(segmentKeys);
  const available = new Set(sources.map(sourceKey));
  if (
    rows.length !== keys.size ||
    new Set(rows.map((r) => r.segmentKey)).size !== keys.size ||
    rows.some(
      (r) => !keys.has(r.segmentKey) || r.insightIndexes.some((i) => !plan.generalInsights[i]),
    ) ||
    plan.generalInsights.some(
      (insight, i) =>
        !rows.some((r) => r.insightIndexes.includes(i)) ||
        !insight.sourceRefs.some((r) => sourceKey(r) === sourceKey(news)) ||
        !insight.sourceRefs.some((r) => available.has(sourceKey(r))) ||
        insight.sourceRefs.some(
          (r) => sourceKey(r) !== sourceKey(news) && !available.has(sourceKey(r)),
        ),
    )
  )
    throw new NewsAnalysisError(
      422,
      'SEGMENT_COVERAGE',
      'Segment plan must cover each input key exactly once with valid insight indexes. Every insight must cite the exact triggering news AND at least one supplied public original; use only supplied refs. Correct the result before submitting.',
    );
}
