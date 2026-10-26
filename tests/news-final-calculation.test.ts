import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { contextBundleSchema } from '../src/news-analysis/contracts/analysis.ts';
import { resolveCompanyResult } from '../src/news-analysis/reasoning/company-result.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const time = '2026-10-26T08:00:00Z';
const source = (materialId: string, kind: 'news' | 'company', text: string) => ({
  materialId,
  versionId: 'v1',
  sourceId: 'synthetic-only',
  kind,
  title: materialId,
  text,
  knownAt: time,
  companyIds: kind === 'company' ? [companyId] : [],
  bankProfileIds: [],
  contentHash: createHash('sha256').update(text).digest('hex'),
});
const scope = {
  companyId,
  asOf: time,
  sources: [
    source(
      'news',
      'news',
      'SYNTHETIC FIXTURE ONLY. FixtureBench increases from 12% to 14% for 2027.',
    ),
    source(
      'own',
      'company',
      'SYNTHETIC FIXTURE ONLY. Loan Loan-Final-001 has constant principal RUB 1000000 throughout 2027 and immediately resets from 12% to 14%.',
    ),
  ],
  objects: [{ handle: 'o0', literal: 'Loan-Final-001', sourceHandles: ['s1'] }],
  questions: [],
};
function result() {
  return {
    category: 'risk',
    objectHandle: 'o0',
    question: {
      mechanism: 'financing_cost',
      frame: 'event_only',
      unit: 'RUB',
      targetPeriod: '2027',
      baselinePeriod: null,
      basis: 'contract_total',
    },
    assessment: {
      applicability: {
        status: 'established',
        basis: 'documented_exposure',
        explanation: 'The synthetic loan is documented.',
        sourceHandles: ['s1'],
        assumptions: [],
      },
      conditions: [],
      unknowns: [],
    },
    conclusion: 'Расходы по синтетическому договору вырастут на 20000 RUB за 2027 год.',
    status: 'forecast',
    impact: {
      metric: 'expense_delta',
      amountBasis: 'contract_total',
      economicObjectHandle: 'e0',
      evidenceStatus: 'supported',
      importance: 0,
      urgency: 1,
      novelty: 1,
    },
    companyImportance: {
      score: null,
      rationale: 'Business scale is unknown.',
      evidenceSourceHandles: [],
    },
    sourceHandles: ['s0', 's1'],
    calculation: { expression: '1000000*(0.14-0.12)', unit: 'RUB', period: '2027' },
  };
}

it('rejects a final quantitative forecast which silently omits its proposed calculation', () => {
  const native = result();
  const proposedDrafts = resolveCompanyResult({ drafts: [native] }, scope);
  const { calculation: _calculation, ...omitted } = native;
  const finalScope = { ...scope, proposedDrafts };
  expect(() => resolveCompanyResult({ drafts: [omitted] }, finalScope)).toThrow(
    expect.objectContaining({ code: 'FINAL_CALCULATION_REQUIRED', status: 422 }),
  );
});

it('keeps an explicit final calculation and legitimately unknown company importance', () => {
  const native = result();
  const proposedDrafts = resolveCompanyResult({ drafts: [native] }, scope);
  const finalScope = { ...scope, proposedDrafts };
  const [final] = resolveCompanyResult({ drafts: [native] }, finalScope);
  expect(final?.calculation).toEqual(proposedDrafts[0]?.calculation);
  expect(final?.companyImportance?.score).toBeNull();
  expect(final?.companyImportance?.rationale).toBe('Business scale is unknown.');
});

it('allows withdrawal of the preliminary draft without manufacturing a saved calculation', () => {
  const proposedDrafts = resolveCompanyResult({ drafts: [result()] }, scope);
  expect(resolveCompanyResult({ drafts: [] }, { ...scope, proposedDrafts })).toEqual([]);
});

it('allows an explicit unknown with structured missing facts and no manufactured amount', () => {
  const native = result();
  const proposedDrafts = resolveCompanyResult({ drafts: [native] }, scope);
  const { calculation: _calculation, ...omitted } = native;
  const withdrawal = {
    ...omitted,
    status: 'unknown',
    conclusion: 'The required index identity is not established; no effect is calculated.',
    impact: { ...omitted.impact, evidenceStatus: 'unknown' },
    assessment: {
      ...omitted.assessment,
      unknowns: [
        {
          id: 'index_identity',
          fact: 'The required index identity is not established.',
          query: null,
          scope: 'company',
          materialId: 'own',
        },
      ],
    },
  };
  const [final] = resolveCompanyResult({ drafts: [withdrawal] }, { ...scope, proposedDrafts });
  expect(final?.calculation).toBeUndefined();
  expect(final?.status).toBe('unknown');
  expect(final?.assessment?.unknowns).toHaveLength(1);
});

it.each(['no_missing_fact', 'still_supported'])(
  'rejects an unexplained or inconsistent withdrawal: %s',
  (defect) => {
    const native = result();
    const proposedDrafts = resolveCompanyResult({ drafts: [native] }, scope);
    const { calculation: _calculation, ...omitted } = native;
    const withdrawal = {
      ...omitted,
      status: 'unknown',
      conclusion: 'No calculation.',
      impact: {
        ...omitted.impact,
        evidenceStatus: defect === 'still_supported' ? 'supported' : 'unknown',
      },
      assessment: {
        ...omitted.assessment,
        unknowns:
          defect === 'no_missing_fact'
            ? []
            : [
                {
                  id: 'missing',
                  fact: 'A required input is unknown.',
                  query: null,
                  scope: 'company',
                  materialId: 'own',
                },
              ],
      },
    };
    expect(() =>
      resolveCompanyResult({ drafts: [withdrawal] }, { ...scope, proposedDrafts }),
    ).toThrow(expect.objectContaining({ code: 'FINAL_CALCULATION_REQUIRED' }));
  },
);

it('accepts a grounded revised final expression without copying the preliminary expression', () => {
  const native = result();
  const proposedDrafts = resolveCompanyResult({ drafts: [native] }, scope);
  const corrected = {
    ...native,
    calculation: { ...native.calculation, expression: '1000000*0.02' },
  };
  const [final] = resolveCompanyResult({ drafts: [corrected] }, { ...scope, proposedDrafts });
  expect(final?.calculation?.expression).not.toEqual(proposedDrafts[0]?.calculation?.expression);
  expect(final?.calculation).toMatchObject({ unit: 'RUB', period: '2027' });
});

it('does not turn a documented principal in a genuine qualitative result into a calculated effect', () => {
  const native = result();
  const { calculation: _calculation, ...omitted } = native;
  const qualitative = {
    ...omitted,
    status: 'unknown',
    conclusion:
      'The source documents principal RUB 1000000; the change in expense remains unknown.',
    question: {
      ...native.question,
      unit: 'qualitative',
      targetPeriod: 'unknown',
      basis: 'qualitative',
    },
    impact: { ...omitted.impact, evidenceStatus: 'unknown', economicObjectHandle: null },
    assessment: {
      ...omitted.assessment,
      unknowns: [
        {
          id: 'missing',
          fact: 'The event applicability is unknown.',
          query: null,
          scope: 'company',
          materialId: 'own',
        },
      ],
    },
  };
  const proposedDrafts = resolveCompanyResult({ drafts: [qualitative] }, scope);
  const [final] = resolveCompanyResult({ drafts: [qualitative] }, { ...scope, proposedDrafts });
  expect(final?.calculation).toBeUndefined();
  expect(final?.conclusion).toContain('RUB 1000000');
});

it('does not inherit a preliminary calculation into a distinct qualitative question', () => {
  const native = result();
  const proposedDrafts = resolveCompanyResult({ drafts: [native] }, scope);
  const { calculation: _calculation, ...omitted } = native;
  const qualitative = {
    ...omitted,
    status: 'unknown',
    conclusion: 'A separate qualitative effect remains unknown.',
    question: {
      ...native.question,
      unit: 'qualitative',
      targetPeriod: 'unknown',
      basis: 'qualitative',
    },
    impact: { ...native.impact, economicObjectHandle: null, evidenceStatus: 'unknown' },
    assessment: {
      ...native.assessment,
      unknowns: [
        {
          id: 'missing',
          fact: 'A required input is unknown.',
          query: null,
          scope: 'company',
          materialId: 'own',
        },
      ],
    },
  };
  const [final] = resolveCompanyResult({ drafts: [qualitative] }, { ...scope, proposedDrafts });
  expect(final?.question?.unit).toBe('qualitative');
  expect(final?.calculation).toBeUndefined();
});

it('rejects final omission before canonical preparation or saving through the analyzer', async () => {
  const proposedDrafts = resolveCompanyResult({ drafts: [result()] }, scope);
  const first = proposedDrafts[0];
  if (!first) throw new Error('Missing synthetic proposal');
  const { calculation: _calculation, ...omitted } = first;
  const noHttp: typeof fetch = async () => {
    throw new Error('Unexpected HTTP in a model-free fixture');
  };
  const context = new ContextClient('http://context.test', 'unit-only', noHttp);
  const insights = new InsightClient('http://insight.test', 'unit-only', noHttp);
  vi.spyOn(context, 'getContext').mockResolvedValue(
    contextBundleSchema.parse({
      news: scope.sources[0],
      materials: scope.sources.slice(1),
      coverage: {
        asOf: time,
        complete: true,
        materialCount: 2,
        companyMaterialCount: 1,
        marketMaterialCount: 0,
        previousNewsVersionCount: 0,
        characters: 500,
      },
    }),
  );
  vi.spyOn(insights, 'analysisSession').mockResolvedValue({
    receipt: null,
    previousEffects: [],
    stateVersion: 0,
  });
  vi.spyOn(insights, 'preview').mockResolvedValue({
    results: [{ valid: true, result: '20000', unit: 'RUB', period: '2027', arithmeticOnly: true }],
  });
  const prepare = vi.spyOn(insights, 'prepare');
  const save = vi.spyOn(insights, 'saveAnalysis');
  const analyzer = new NewsAnalyzer({
    context,
    insights,
    reasoner: {
      retrievalMode: 'agent_tools',
      analyze: async () => proposedDrafts,
      review: async () => [omitted],
    },
  });
  await expect(
    analyzer.analyze({ companyId, newsMaterialId: 'news', newsVersionId: 'v1', asOf: time }),
  ).rejects.toMatchObject({ code: 'FINAL_CALCULATION_REQUIRED', status: 422 });
  expect(prepare).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
