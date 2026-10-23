import { describe, expect, it } from 'vitest';
import {
  canonicalFacts,
  decimalSum,
  groupProjection,
  priority,
} from '../src/news-analysis/application/projections.ts';
import { analysisReceiptSchema } from '../src/news-analysis/contracts/analysis.ts';
import type { CompanyRun, GroupExpansion } from '../src/news-analysis/contracts/flow.ts';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const time = '2026-10-22T10:00:00Z';
function run(
  companyId: string,
  amount: string,
  period = '2026-11',
  object: string | null = null,
): CompanyRun {
  return {
    companyId,
    status: 'completed',
    contextComplete: true,
    receipt: analysisReceiptSchema.parse({
      analysisId: `a-${companyId}`,
      companyId,
      newsMaterialId: 'news',
      newsVersionId: '1',
      asOf: time,
      completedAt: time,
      duplicate: false,
      resultSemantics: 'saved_analysis_revisions_not_latest_heads',
      effects: [
        {
          effectId: `e-${companyId}`,
          revisionId: `r-${companyId}`,
          previousRevisionId: null,
          duplicate: false,
          currentRevision: {
            revisionId: `r-${companyId}`,
            previousRevisionId: null,
            newsVersionId: '1',
            asOf: time,
            conclusion: 'Source-supported additional contractual expense',
            status: 'forecast',
            sourceRefs: [],
            calculation: { expression: { kind: 'value', value: amount }, unit: 'RUB', period },
            calculationResult: amount,
            calculationArithmeticOnly: true,
            createdAt: time,
            impact: {
              metric: 'expense_delta',
              amountBasis: 'contract_budget',
              economicObjectId: object,
              evidenceStatus: 'supported',
              importance: 5,
              urgency: 3,
              novelty: 4,
            },
          },
        },
      ],
    }),
  };
}
const group: GroupExpansion = {
  aggregationRule: 'sum_compatible_owner_effects',
  groupId: 'root',
  companyIds: [a, b],
  paths: [
    { companyId: a, groupIds: ['root'] },
    { companyId: a, groupIds: ['root', 'nested'] },
    { companyId: b, groupIds: ['root', 'nested'] },
  ],
  missingGroups: [],
  cycles: [],
  complete: true,
  sourceRefs: [],
};

describe('canonical group and role projections', () => {
  it('does not use an unrelated legacy unaffected effect as a zero financing contribution', () => {
    const first = run(a, '100'),
      second = run(b, '0');
    const aRevision = first.receipt?.effects[0]?.currentRevision,
      bRevision = second.receipt?.effects[0]?.currentRevision;
    if (!aRevision || !bRevision?.impact) throw new Error('Missing fixture');
    aRevision.question = {
      mechanism: 'financing_cost',
      frame: 'absolute',
      unit: 'RUB',
      targetPeriod: '2026-11',
      baselinePeriod: null,
      basis: 'monthly_run_rate',
    };
    bRevision.impact.evidenceStatus = 'unaffected';
    bRevision.impact.metric = 'fuel_policy';
    bRevision.calculation = null;
    bRevision.calculationResult = null;
    const result = groupProjection(group, [first, second]);
    expect(result.complete).toBe(false);
    expect(result.totals[0]?.fullTotal).toBeNull();
    expect(result.totals[0]?.coverage.missingCompanyIds).toContain(b);
  });
  it('retains a complete financing frame when an unrelated rent question remains unknown', () => {
    const first = run(a, '100'),
      second = run(b, '200');
    const finance = {
      mechanism: 'financing_cost' as const,
      frame: 'absolute' as const,
      unit: 'RUB',
      targetPeriod: '2026-11',
      baselinePeriod: null,
      basis: 'monthly_run_rate' as const,
    };
    for (const c of [first, second]) {
      const r = c.receipt?.effects[0]?.currentRevision;
      if (!r) throw new Error('Missing fixture');
      r.question = finance;
    }
    const original = first.receipt?.effects[0];
    if (!original || !first.receipt) throw new Error('Missing fixture');
    const rent = structuredClone(original);
    rent.effectId = 'unknown-rent';
    rent.currentRevision.question = {
      mechanism: 'rent_indexation',
      frame: 'absolute',
      unit: 'RUB',
      targetPeriod: '2026-11',
      baselinePeriod: null,
      basis: 'monthly_run_rate',
    };
    rent.currentRevision.calculation = null;
    rent.currentRevision.calculationResult = null;
    if (!rent.currentRevision.impact) throw new Error('Missing fixture');
    rent.currentRevision.impact.evidenceStatus = 'unknown';
    first.receipt.effects.push(rent);
    const view = groupProjection(group, [first, second]);
    expect(view.complete).toBe(false);
    expect(view.totals).toMatchObject([
      { knownSubtotal: '300', fullTotal: '300', coverage: { complete: true } },
    ]);
    expect(view.coverage.unknownEffects).toContain('unknown-rent');
  });
  it('uses canonical decimal digits in human/role facts and excludes raw model explanation', () => {
    const company = run(a, '8000');
    const revision = company.receipt?.effects[0]?.currentRevision;
    if (!revision) throw new Error('Missing fixture');
    revision.conclusion = 'Wrong model text: 800 RUB';
    revision.modelExplanation = 'Unverified model arithmetic: 800 RUB';
    const fact = canonicalFacts([company])[0];
    expect(fact?.revision.conclusion).toContain('8000 RUB');
    expect(fact?.revision.conclusion).not.toContain('800 RUB');
    expect(fact?.revision).not.toHaveProperty('modelExplanation');
  });
  it('keeps different comparison baselines in separate compatible frames', () => {
    const first = run(a, '100'),
      second = run(b, '200');
    for (const [company, baseline] of [
      [first, 'budget:2025-11'],
      [second, 'budget:2026-11'],
    ] as const) {
      const revision = company.receipt?.effects[0]?.currentRevision;
      if (!revision) throw new Error('Missing fixture');
      revision.question = {
        mechanism: 'financing_cost',
        frame: 'budget_delta',
        unit: 'RUB',
        targetPeriod: '2026-11',
        baselinePeriod: baseline,
        basis: 'budget_total',
      };
    }
    const view = groupProjection(group, [first, second]);
    expect(view.totals.map((t) => t.knownSubtotal).sort()).toEqual(['100', '200']);
    expect(view.totals.map((t) => t.question?.baselinePeriod).sort()).toEqual([
      'budget:2025-11',
      'budget:2026-11',
    ]);
  });
  it('keeps root and intermediate own obligations and counts repeated leaf paths once', () => {
    const c = '33333333-3333-4333-8333-333333333333';
    const nested = {
      ...group,
      companyIds: [a, b, c],
      paths: [
        { companyId: a, groupIds: ['root'] },
        { companyId: b, groupIds: ['root', 'middle'] },
        { companyId: c, groupIds: ['root', 'middle', 'leaf'] },
        { companyId: c, groupIds: ['root', 'leaf'] },
      ],
    };
    expect(groupProjection(nested, [run(a, '100'), run(b, '200'), run(c, '300')])).toMatchObject({
      complete: true,
      totals: [{ fullTotal: '600' }],
    });
  });
  it('excludes invalidated premises from supported subtotals while preserving the coverage gap', () => {
    const first = run(a, '100');
    first.staleEffectIds = [`e-${a}`];
    const projection = groupProjection(group, [first, run(b, '200')]);
    expect(projection.complete).toBe(false);
    expect(projection.totals).toMatchObject([{ knownSubtotal: '200', fullTotal: null }]);
    expect(projection.coverage.unrevisedEffectIds).toContain(`e-${a}`);
  });
  it('adds Decimal strings exactly with negative and subunit quantities', () => {
    expect(decimalSum(['9007199254740993.01', '-0.02', '0.01'])).toBe('9007199254740993');
    expect(decimalSum(['-0.1', '-0.20'])).toBe('-0.3');
    expect(decimalSum(['0.1', '-0.1'])).toBe('0');
  });
  it('counts owners once through multiple paths and never mixes periods', () => {
    const result = groupProjection(group, [run(a, '1.10'), run(b, '2.20')]);
    expect(result.totals[0]?.fullTotal).toBe('3.3');
    expect(result.coverage.expectedCompanies).toBe(2);
    expect(groupProjection(group, [run(a, '1'), run(b, '2', '2026-12')]).totals).toHaveLength(2);
  });
  it('keeps missing members, unknown effects and duplicated obligations out of full totals', () => {
    expect(groupProjection(group, [run(a, '1')]).totals[0]?.fullTotal).toBeNull();
    const unknown = run(b, '2');
    const effect = unknown.receipt?.effects[0];
    if (!effect?.currentRevision.impact) throw new Error('Missing test effect');
    effect.currentRevision.impact.evidenceStatus = 'unknown';
    expect(groupProjection(group, [run(a, '1'), unknown]).totals[0]?.fullTotal).toBeNull();
    const duplicate = groupProjection(group, [
      run(a, '1', '2026-11', 'shared-contract'),
      run(b, '1', '2026-11', 'shared-contract'),
    ]);
    expect(duplicate.totals[0]?.knownSubtotal).toBe('1');
    expect(duplicate.totals[0]?.fullTotal).toBeNull();
    expect(duplicate.coverage.duplicateObjects).toHaveLength(1);
  });
  it('reduces business priority with unresolved evidence', () => {
    const revision = run(a, '1').receipt?.effects[0]?.currentRevision;
    if (!revision?.impact) throw new Error('Missing test revision');
    const supported = priority(revision);
    revision.impact.evidenceStatus = 'unknown';
    expect(priority(revision)).toBeLessThan(supported);
  });
  it('does not turn omitted prior effects or an empty receipt into a complete group total', () => {
    const unreviewed = run(b, '2');
    if (!unreviewed.receipt) throw new Error('Missing fixture receipt');
    unreviewed.receipt.unrevisedEffectIds = ['older-obligation'];
    const result = groupProjection(group, [run(a, '1'), unreviewed]);
    expect(result.complete).toBe(false);
    expect(result.coverage.unrevisedEffectIds).toEqual(['older-obligation']);
    expect(result.totals[0]?.fullTotal).toBeNull();
    unreviewed.receipt.effects = [];
    unreviewed.receipt.unrevisedEffectIds = [];
    expect(groupProjection(group, [run(a, '1'), unreviewed]).coverage.emptyCompanyIds).toEqual([b]);
    expect(groupProjection(group, [run(a, '1'), unreviewed]).totals[0]?.fullTotal).toBeNull();
  });
});
