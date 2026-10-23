import type { AnalysisReceipt } from '../contracts/analysis.ts';
import type { CompanyRun, GroupExpansion, RoleFact, RoleGroup } from '../contracts/flow.ts';

// Exact decimal addition over strings; no IEEE-754 conversions of money.
export function decimalSum(values: string[]): string {
  let scale = 0;
  const parts = values.map((value) => {
    if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error('Invalid canonical decimal');
    const [whole = '0', fraction = ''] = value.split('.');
    scale = Math.max(scale, fraction.length);
    return { digits: BigInt(whole + fraction), scale: fraction.length };
  });
  const sum = parts.reduce((total, p) => total + p.digits * 10n ** BigInt(scale - p.scale), 0n);
  const sign = sum < 0n ? '-' : '';
  const digits = (sum < 0n ? -sum : sum).toString().padStart(scale + 1, '0');
  if (!scale) return sign + digits;
  return `${sign + digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
}

export function priority(revision: AnalysisReceipt['effects'][number]['currentRevision']): number {
  const p = revision.impact;
  if (!p) return 0;
  const confidence =
    p.evidenceStatus === 'supported' ? 1 : p.evidenceStatus === 'conditional' ? 0.6 : 0.2;
  return Math.round(
    (100 * confidence * (0.5 * p.importance + 0.3 * p.urgency + 0.2 * p.novelty)) / 5,
  );
}

export function groupProjection(group: GroupExpansion, companies: CompanyRun[]): RoleGroup {
  const runs = new Map(companies.map((r) => [r.companyId.toLowerCase(), r]));
  const missing = group.companyIds.filter(
    (id) => runs.get(id.toLowerCase())?.status !== 'completed',
  );
  const partialContextCompanyIds = group.companyIds.filter(
    (id) => runs.get(id.toLowerCase())?.contextComplete !== true,
  );
  const frames = new Map<
    string,
    {
      metric: string;
      amountBasis: string;
      unit: string;
      period: string;
      values: string[];
      effectIds: string[];
      companyIds: string[];
      sharedObjects: Set<string>;
      question: AnalysisReceipt['effects'][number]['currentRevision']['question'];
    }
  >();
  const unknownEffects: string[] = [];
  const duplicateObjects: string[] = [];
  const unrevisedEffectIds = group.companyIds.flatMap((id) => [
    ...(runs.get(id.toLowerCase())?.receipt?.unrevisedEffectIds ?? []),
    ...(runs.get(id.toLowerCase())?.staleEffectIds ?? []),
  ]);
  const emptyCompanyIds = group.companyIds.filter(
    (id) => runs.get(id.toLowerCase())?.receipt?.effects.length === 0,
  );
  const byEffect = new Map(
    companies.flatMap(
      (c) => c.receipt?.effects.map((e) => [e.effectId, e.currentRevision] as const) ?? [],
    ),
  );
  for (const company of new Set(group.companyIds.map((x) => x.toLowerCase()))) {
    const receipt = runs.get(company)?.receipt;
    if (!receipt) continue;
    for (const saved of receipt.effects) {
      if (runs.get(company)?.staleEffectIds?.includes(saved.effectId)) {
        unknownEffects.push(saved.effectId);
        continue;
      }
      const r = saved.currentRevision;
      const p = r.impact;
      if (p?.evidenceStatus !== 'supported' || !r.calculation || r.calculationResult == null) {
        if (p?.evidenceStatus !== 'unaffected') unknownEffects.push(saved.effectId);
        continue;
      }
      const key = JSON.stringify([
        r.question?.mechanism ?? null,
        r.question?.frame ?? null,
        r.question?.baselinePeriod ?? null,
        r.question?.basis ?? null,
        p.metric,
        p.amountBasis,
        r.calculation.unit,
        r.calculation.period,
      ]);
      let frame = frames.get(key);
      if (!frame) {
        frame = {
          metric: p.metric,
          amountBasis: p.amountBasis,
          unit: r.calculation.unit,
          period: r.calculation.period,
          values: [],
          effectIds: [],
          companyIds: [],
          sharedObjects: new Set(),
          question: r.question,
        };
        frames.set(key, frame);
      }
      if (p.economicObjectId && frame.sharedObjects.has(p.economicObjectId)) {
        duplicateObjects.push(saved.effectId);
        continue;
      }
      if (p.economicObjectId) frame.sharedObjects.add(p.economicObjectId);
      frame.values.push(r.calculationResult);
      frame.effectIds.push(saved.effectId);
      frame.companyIds.push(company);
    }
  }
  const complete =
    group.complete &&
    group.aggregationRule === 'sum_compatible_owner_effects' &&
    partialContextCompanyIds.length === 0 &&
    missing.length === 0 &&
    unknownEffects.length === 0 &&
    duplicateObjects.length === 0;
  const coverageComplete =
    complete && unrevisedEffectIds.length === 0 && emptyCompanyIds.length === 0;
  const totals = (
    group.aggregationRule === 'sum_compatible_owner_effects' ? [...frames.values()] : []
  ).map((f) => {
    const related = (id: string) => {
      const question = byEffect.get(id)?.question;
      if (!question || !f.question) return true;
      return (
        question.mechanism === f.question.mechanism &&
        question.frame === f.question.frame &&
        (question.targetPeriod === 'unknown' ||
          question.targetPeriod === f.question.targetPeriod) &&
        (question.unit === 'unknown' || question.unit === f.question.unit) &&
        (question.baselinePeriod === 'unknown' ||
          question.baselinePeriod === f.question.baselinePeriod) &&
        (question.basis == null ||
          question.basis === 'unknown' ||
          question.basis === f.question.basis)
      );
    };
    const unresolved = [...new Set([...unknownEffects, ...unrevisedEffectIds])].filter(related);
    const duplicates = duplicateObjects.filter(related);
    const sameFrameUnaffected = (
      revision: AnalysisReceipt['effects'][number]['currentRevision'],
    ) => {
      if (revision.impact?.evidenceStatus !== 'unaffected') return false;
      const q = revision.question;
      if (f.question)
        return (
          !!q &&
          q.mechanism === f.question.mechanism &&
          q.frame === f.question.frame &&
          q.unit === f.question.unit &&
          q.targetPeriod === f.question.targetPeriod &&
          q.baselinePeriod === f.question.baselinePeriod &&
          q.basis === f.question.basis
        );
      return (
        !q &&
        revision.calculation?.unit === f.unit &&
        revision.calculation.period === f.period &&
        revision.impact.metric === f.metric &&
        revision.impact.amountBasis === f.amountBasis
      );
    };
    const absent = group.companyIds.filter(
      (id) =>
        !f.companyIds.includes(id.toLowerCase()) &&
        !runs
          .get(id.toLowerCase())
          ?.receipt?.effects.some((e) => sameFrameUnaffected(e.currentRevision)),
    );
    const frameComplete =
      group.complete &&
      group.aggregationRule === 'sum_compatible_owner_effects' &&
      !missing.length &&
      !partialContextCompanyIds.length &&
      !emptyCompanyIds.length &&
      !unresolved.length &&
      !duplicates.length &&
      !absent.length &&
      (!f.question ||
        (!!f.question.basis &&
          f.question.basis !== 'unknown' &&
          f.question.unit !== 'unknown' &&
          f.question.targetPeriod !== 'unknown' &&
          f.question.baselinePeriod !== 'unknown'));
    return {
      metric: f.metric,
      amountBasis: f.amountBasis,
      unit: f.unit,
      period: f.period,
      question: f.question ?? null,
      knownSubtotal: decimalSum(f.values),
      fullTotal: frameComplete ? decimalSum(f.values) : null,
      coverage: {
        complete: frameComplete,
        missingCompanyIds: absent,
        unresolvedEffectIds: unresolved,
        duplicateObjects: duplicates,
      },
      effectIds: f.effectIds,
      companyIds: [...new Set(f.companyIds)],
    };
  });
  return {
    groupId: group.groupId,
    companyIds: [...new Set(group.companyIds.map((id) => id.toLowerCase()))],
    complete: coverageComplete && totals.every((f) => f.coverage.complete),
    coverage: {
      expectedCompanies: group.companyIds.length,
      analyzedCompanies: group.companyIds.length - missing.length,
      missingCompanyIds: missing,
      missingGroups: group.missingGroups,
      cycles: group.cycles,
      unknownEffects,
      duplicateObjects,
      unrevisedEffectIds,
      emptyCompanyIds,
      partialContextCompanyIds,
      aggregationRuleConfirmed: group.aggregationRule === 'sum_compatible_owner_effects',
    },
    totals,
    sourceRefs: group.sourceRefs,
  };
}

export function canonicalFacts(companies: CompanyRun[]): RoleFact[] {
  return companies.flatMap(
    (c) =>
      c.receipt?.effects.map((e) => ({
        companyId: c.companyId,
        effectId: e.effectId,
        revision: factRevision(e.currentRevision),
      })) ?? [],
  );
}

// Presentation of verified decimal results never relies on a model retyping
// their digits. Raw explanation remains in the immutable audit receipt only.
function factRevision(revision: AnalysisReceipt['effects'][number]['currentRevision']) {
  const { modelExplanation: _audit, ...fact } = revision;
  if (!revision.calculation || revision.calculationResult == null) return fact;
  const label =
    revision.question?.frame === 'budget_delta'
      ? 'Расчётное отклонение от бюджета (новое значение минус baseline)'
      : revision.question?.frame === 'event_only'
        ? 'Расчётное изменение от события'
        : 'Расчётное абсолютное значение';
  return {
    ...fact,
    conclusion: `${label}: ${revision.calculationResult} ${revision.calculation.unit}; период ${revision.calculation.period}. Применимость определяется сохранёнными условиями и статусом основания. Расчёт не подтверждает фактическую оплату.`,
  };
}
