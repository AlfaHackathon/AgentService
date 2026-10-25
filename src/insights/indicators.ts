import type { z } from 'zod';
import type { materialSchema } from '../news-analysis/contracts/analysis.ts';
import { sourceKey } from '../news-analysis/retrieval/source-catalog.ts';
import type { indicatorAvailabilitySchema, indicatorSchema, StoredRevision } from './schemas.ts';

const names: Record<string, string> = {
  expense_delta: 'Изменение расходов',
  revenue_delta: 'Изменение выручки',
  cashflow_delta: 'Изменение денежного потока',
  absolute_expense: 'Расходы',
};
const explanations = {
  available: 'Показатель из сохранённого расчёта; статус основания указан отдельно.',
  no_calculation: 'В этой ревизии нет обоснованного расчёта.',
  missing_result: 'Расчётный результат неизвестен; нулём не подменяется.',
  stale_sources: 'Основания требуют пересмотра; актуальный показатель не подтверждён.',
  insufficient_evidence: 'Недостаточно подтверждённых собственных оснований для показателя.',
  unknown_period: 'Период расчёта не установлен.',
  unknown_baseline: 'База бюджетного сравнения не установлена.',
  general_not_company_calculation: 'Общий вывод не является расчётом показателей компании.',
};
export function unavailableIndicators(reason: keyof typeof explanations): {
  indicators: z.infer<typeof indicatorSchema>[];
  indicatorAvailability: z.infer<typeof indicatorAvailabilitySchema>;
} {
  return { indicators: [], indicatorAvailability: { reason, explanation: explanations[reason] } };
}
export function projectIndicators(
  revision: StoredRevision,
  stale: boolean,
  sources: z.infer<typeof materialSchema>[],
  companyId: string,
) {
  if (stale) return unavailableIndicators('stale_sources');
  if (!revision.calculation) return unavailableIndicators('no_calculation');
  if (
    revision.calculationResult == null ||
    !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(revision.calculationResult)
  )
    return unavailableIndicators('missing_result');
  const status = revision.impact?.evidenceStatus;
  const cited = new Set(revision.sourceRefs.map(sourceKey));
  const own = sources.some(
    (s) =>
      s.kind === 'company' &&
      s.companyIds.some((id) => id.toLowerCase() === companyId) &&
      cited.has(sourceKey(s)),
  );
  if (!own || (status !== 'supported' && status !== 'conditional'))
    return unavailableIndicators('insufficient_evidence');
  if (revision.calculation.period === 'unknown' || revision.question?.targetPeriod === 'unknown')
    return unavailableIndicators('unknown_period');
  if (
    revision.question?.frame === 'budget_delta' &&
    (!revision.question.baselinePeriod || revision.question.baselinePeriod === 'unknown')
  )
    return unavailableIndicators('unknown_baseline');
  const metric = revision.impact?.metric ?? 'other';
  return {
    indicators: [
      {
        name: names[metric] ?? 'Расчётный показатель',
        metric,
        value: revision.calculationResult,
        unit: revision.calculation.unit,
        period: revision.calculation.period,
        baselinePeriod:
          revision.question?.baselinePeriod && revision.question.baselinePeriod !== 'unknown'
            ? revision.question.baselinePeriod
            : null,
        evidenceStatus: status,
        sourceRefs: revision.sourceRefs,
        arithmeticOnly: revision.calculationArithmeticOnly ?? null,
      },
    ],
    indicatorAvailability: { reason: 'available' as const, explanation: explanations.available },
  };
}
