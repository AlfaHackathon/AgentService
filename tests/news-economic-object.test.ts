import * as v from 'valibot';
import { expect, it } from 'vitest';
import { questionSchema } from '../src/news-analysis/contracts/questions.ts';
import { companyResultSchema } from '../src/news-analysis/reasoning/agent-schemas.ts';
import { economicObjectCatalog } from '../src/news-analysis/retrieval/economic-objects.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const source = {
  materialId: 'contract',
  versionId: 'v1',
  contentHash: 'a'.repeat(64),
  sourceId: 'fixture',
  kind: 'company' as const,
  title: 'Own agreement',
  text: 'The company holds loan CREDIT-42. Principal is RUB 1000000.',
  knownAt: '2026-10-25T00:00:00Z',
  companyIds: [companyId],
  bankProfileIds: [],
};
it('exposes an explicitly documented English loan as a selectable object', () => {
  expect(
    economicObjectCatalog([source], companyId, source.knownAt).some(
      (o) => o.economicObjectId === 'CREDIT-42',
    ),
  ).toBe(true);
});
it('does not accept an unbound null economic object in a monetary tool result', () => {
  const draft = {
    objectHandle: 'o0',
    assessment: { conditions: [], unknowns: [] },
    question: {
      mechanism: 'financing_cost',
      frame: 'event_only',
      unit: 'RUB',
      targetPeriod: '2027',
      baselinePeriod: null,
      basis: 'annual_run_rate',
    },
    conclusion: 'Interest delta',
    status: 'announced',
    impact: {
      metric: 'expense_delta',
      amountBasis: 'annual_run_rate',
      economicObjectId: null,
      evidenceStatus: 'supported',
      importance: 1,
      urgency: 1,
      novelty: 1,
    },
    sourceHandles: ['s0', 's1'],
    calculation: { expression: '1000000*(0.14-0.12)', unit: 'RUB', period: '2027' },
  };
  expect(v.safeParse(companyResultSchema(['o0'], ['s0', 's1']), { drafts: [draft] }).success).toBe(
    false,
  );
});

import {
  type CompanyResultScope,
  resolveCompanyResult,
} from '../src/news-analysis/reasoning/company-result.ts';
import { objectCatalog } from '../src/news-analysis/retrieval/source-catalog.ts';

const news = {
  ...source,
  materialId: 'news',
  kind: 'news' as const,
  companyIds: [],
  text: 'The named reference rate changes.',
  contentHash: 'b'.repeat(64),
};
function scope(own = source): CompanyResultScope {
  const sources = [news, own];
  return {
    companyId,
    asOf: source.knownAt,
    sources,
    objects: objectCatalog(sources, companyId),
    questions: [],
  };
}
function wire() {
  return {
    drafts: [
      {
        objectHandle: 'o0',
        assessment: {
          applicability: {
            status: 'established',
            basis: 'documented_exposure',
            explanation: 'Own loan',
            assumptions: [],
            sourceHandles: ['s1'],
          },
          conditions: [],
          unknowns: [],
        },
        question: {
          mechanism: 'financing_cost',
          frame: 'event_only',
          unit: 'RUB',
          targetPeriod: '2027',
          baselinePeriod: null,
          basis: 'annual_run_rate',
        },
        conclusion: 'Contractual counterfactual, not a budget or payment',
        status: 'announced',
        impact: {
          metric: 'expense_delta',
          amountBasis: 'annual_run_rate',
          economicObjectHandle: 'e0',
          evidenceStatus: 'supported',
          importance: 1,
          urgency: 1,
          novelty: 1,
        },
        sourceHandles: ['s0', 's1'],
        calculation: { expression: '1000000*(0.14-0.12)', unit: 'RUB', period: '2027' },
      },
    ],
  };
}
it('rejects the attempt4 year versus date-range mismatch without rewriting either representation', () => {
  const data = wire();
  Object.assign(data.drafts[0]?.calculation ?? {}, { period: '2027-01-01/2028-01-01' });
  Object.assign(data.drafts[0]?.impact ?? {}, { amountBasis: 'contract_total' });
  const before = structuredClone(data);
  expect(() => resolveCompanyResult(data, scope())).toThrowError(
    expect.objectContaining({ status: 422, code: 'CALCULATION_QUESTION_MISMATCH' }),
  );
  expect(data).toEqual(before);
});
it('checks a resolved previous question without changing its canonical identity or history', () => {
  const data = wire();
  const binding = scope();
  const question = questionSchema.parse(data.drafts[0]?.question);
  binding.questions = [{ handle: 'q0', literal: `company:${companyId}`, question }];
  Object.assign(data.drafts[0] ?? {}, { question: 'q0' });
  Object.assign(data.drafts[0]?.calculation ?? {}, { period: '2027-01-01/2028-01-01' });
  const before = structuredClone(binding.questions);
  expect(() => resolveCompanyResult(data, binding)).toThrowError(
    expect.objectContaining({ status: 422, code: 'CALCULATION_QUESTION_MISMATCH' }),
  );
  expect(binding.questions).toEqual(before);
});
it('resolves only the selected documented ID and preserves the stable company question object', () => {
  const [draft] = resolveCompanyResult(wire(), scope());
  expect(draft?.literalObjectRef).toBe(`company:${companyId}`);
  expect(draft?.impact?.economicObjectId).toBe('CREDIT-42');
  expect(draft?.impact).not.toHaveProperty('economicObjectHandle');
  expect(draft?.sourceRefs[1]).toEqual({
    materialId: 'contract',
    versionId: 'v1',
    contentHash: source.contentHash,
  });
  expect(economicObjectCatalog(scope().sources, companyId, source.knownAt)[0]).toMatchObject({
    companyId,
    evidence: [
      {
        materialId: 'contract',
        versionId: 'v1',
        contentHash: source.contentHash,
        quote: 'loan CREDIT-42.',
      },
    ],
  });
});
it.each(['null', 'fake', 'missing_citation', 'missing_exposure_citation'])(
  'rejects %s object selection without substituting an ID',
  (defect) => {
    const data = wire();
    const draft = data.drafts[0];
    if (!draft) throw new Error('Missing fixture draft');
    if (defect === 'null') Object.assign(draft.impact, { economicObjectHandle: null });
    if (defect === 'fake') draft.impact.economicObjectHandle = 'e99';
    if (defect === 'missing_citation') draft.sourceHandles = ['s0'];
    if (defect === 'missing_exposure_citation')
      draft.assessment.applicability.sourceHandles = ['s0'];
    expect(() => resolveCompanyResult(data, scope())).toThrow();
  },
);
it.each(['foreign', 'public', 'profile', 'future'])(
  'does not grant a selector from a %s source',
  (defect) => {
    const own = { ...source };
    if (defect === 'foreign') own.companyIds = ['22222222-2222-4222-8222-222222222222'];
    if (defect === 'public') Object.assign(own, { kind: 'news', companyIds: [] });
    if (defect === 'profile') own.sourceId = 'provided-bank-csv';
    if (defect === 'future') own.knownAt = '2026-10-26T00:00:00Z';
    expect(economicObjectCatalog([own], companyId, source.knownAt)).toEqual([]);
    expect(() => resolveCompanyResult(wire(), scope(own))).toThrow();
  },
);
it.each(['Loan AGREEMENT-17.', 'Договор №ДГ-28.', 'кредит КР-29.', 'заём ЗА-30.'])(
  'extracts literal identifiers from %s',
  (text) => {
    const catalog = economicObjectCatalog([{ ...source, text }], companyId, source.knownAt);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.economicObjectId).toMatch(/^(?:AGREEMENT-17|ДГ-28|КР-29|ЗА-30)$/u);
  },
);
it('distinguishes contractual delta, absolute level and budget comparison', () => {
  const data = wire();
  const draft = data.drafts[0];
  if (!draft) throw new Error('Missing fixture draft');
  Object.assign(draft.question, { frame: 'absolute' });
  expect(() => resolveCompanyResult(data, scope())).toThrow(/absolute level/);
  Object.assign(draft.impact, { metric: 'absolute_expense' });
  expect(resolveCompanyResult(data, scope())[0]?.question?.frame).toBe('absolute');
  Object.assign(draft.question, { frame: 'budget_delta', baselinePeriod: 'budget:2027' });
  expect(() => resolveCompanyResult(data, scope())).toThrow(/budget_baseline/);
});
it('accepts an actual exact observed budget baseline but not an invented quote', () => {
  const data = wire();
  const draft = data.drafts[0];
  if (!draft) throw new Error('Missing fixture draft');
  const quote = 'Approved budget:2027 for loan CREDIT-42: RUB 120000.';
  Object.assign(draft.question, { frame: 'budget_delta', baselinePeriod: 'budget:2027' });
  Object.assign(draft.assessment, {
    conditions: [
      {
        id: 'budget',
        assertion: 'observed',
        dependsOn: [],
        fact: quote,
        predicate: 'budget_baseline',
        status: 'supported',
        sourceHandles: ['s1'],
      },
    ],
  });
  expect(resolveCompanyResult(data, scope({ ...source, text: quote }))[0]?.question?.frame).toBe(
    'budget_delta',
  );
  expect(() => resolveCompanyResult(data, scope())).toThrow(/budget_baseline/);
});
it('retains qualitative unknown without inventing an economic ID or a monetary zero', () => {
  const data = wire();
  const draft = data.drafts[0];
  if (!draft) throw new Error('Missing fixture draft');
  Object.assign(draft, { calculation: undefined });
  Object.assign(draft.impact, {
    economicObjectHandle: null,
    evidenceStatus: 'unknown',
    amountBasis: 'qualitative',
    metric: 'risk',
  });
  Object.assign(draft.question, {
    unit: 'qualitative',
    targetPeriod: 'unknown',
    basis: 'qualitative',
  });
  expect(resolveCompanyResult(data, scope())[0]).toMatchObject({
    impact: { economicObjectId: null, evidenceStatus: 'unknown' },
  });
});
it('rejects another documented contract behind an explicit literal object', () => {
  const binding = scope({ ...source, text: 'Договор CREDIT-42. Loan CREDIT-43.' });
  const data = wire();
  Object.assign(data.drafts[0] ?? {}, { objectHandle: 'o1' });
  Object.assign(data.drafts[0]?.impact ?? {}, { economicObjectHandle: 'e1' });
  expect(() => resolveCompanyResult(data, binding)).toThrow(/must agree/);
});
it.each(['handle', 'raw'] as const)(
  'preserves an existing economic binding behind a legacy company question (%s)',
  (representation) => {
    const binding = scope({ ...source, text: 'Loan CREDIT-42. Loan CREDIT-43.' });
    const data = wire();
    binding.questions = [
      {
        handle: 'q0',
        literal: `company:${companyId}`,
        economicObjectId: 'CREDIT-42',
        question: questionSchema.parse(data.drafts[0]?.question),
      },
    ];
    if (representation === 'handle') Object.assign(data.drafts[0] ?? {}, { question: 'q0' });
    Object.assign(data.drafts[0]?.impact ?? {}, { economicObjectHandle: 'e1' });
    expect(() => resolveCompanyResult(data, binding)).toThrow(/must agree/);
    Object.assign(data.drafts[0]?.impact ?? {}, { economicObjectHandle: 'e0' });
    expect(resolveCompanyResult(data, binding)[0]?.impact?.economicObjectId).toBe('CREDIT-42');
  },
);
