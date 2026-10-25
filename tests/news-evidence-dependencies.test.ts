import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { validateReferences } from '../src/news-analysis/application/draft-validation.ts';
import type { ContextBundle, EffectDraft } from '../src/news-analysis/contracts/analysis.ts';
import { assessmentSchema } from '../src/news-analysis/contracts/analysis.ts';
import { validateEvidenceDependencies } from '../src/news-analysis/contracts/evidence-dependencies.ts';
import { companyResultSchema } from '../src/news-analysis/reasoning/agent-schemas.ts';

const news = {
  materialId: 'synthetic-index-news',
  versionId: 'v1',
  contentHash: 'a'.repeat(64),
};
const loan = {
  materialId: 'synthetic-loan',
  versionId: 'signed-v1',
  contentHash: 'b'.repeat(64),
};
const context: ContextBundle = {
  news: {
    ...news,
    sourceId: 'synthetic-publication',
    kind: 'news',
    title: 'Invented index update',
    text: 'Synthetic index A increases from 10 to 12 percent.',
    knownAt: '2026-10-24T00:00:00Z',
    companyIds: [],
    bankProfileIds: [],
  },
  materials: [
    {
      ...loan,
      sourceId: 'synthetic-contract',
      kind: 'company',
      title: 'Invented floating-rate contract',
      text: 'Principal RUB 1000000. Reference index plus 2 percentage points; immediate reset.',
      knownAt: '2026-10-24T00:00:00Z',
      companyIds: ['11111111-1111-4111-8111-111111111111'],
      bankProfileIds: [],
    },
  ],
  coverage: {
    complete: true,
    materialCount: 1,
    companyMaterialCount: 1,
    marketMaterialCount: 0,
    previousNewsVersionCount: 0,
    characters: 200,
    asOf: '2026-10-24T00:00:00Z',
  },
};

function contradiction(): EffectDraft {
  return {
    effectKey: 'synthetic-interest',
    literalObjectRef: 'SYNTHETIC-LOAN',
    status: 'unknown',
    conclusion: 'Index identity is unconfirmed; a rate increase is not established.',
    sourceRefs: [news, loan],
    assessment: {
      conditions: [
        {
          id: 'index_identity',
          assertion: 'observed',
          dependsOn: [],
          fact: 'The news reports index A, while the contract names a reference index.',
          predicate: 'The news index is the contract reference index.',
          status: 'unknown',
          sourceRefs: [news, loan],
        },
        {
          id: 'rate_change',
          assertion: 'derived',
          dependsOn: ['index_identity'],
          fact: 'News index rises from 10 to 12; contract has index plus 2 and immediate reset.',
          predicate: 'The loan rate rises from 12 to 14 percent, increasing interest cost.',
          status: 'supported',
          sourceRefs: [news, loan],
        },
        {
          id: 'principal',
          assertion: 'observed',
          dependsOn: [],
          fact: 'Contract principal is RUB 1000000.',
          predicate: 'The company has a RUB 1000000 principal balance.',
          status: 'supported',
          sourceRefs: [loan],
        },
      ],
      unknowns: [
        {
          id: 'missing_index_identity',
          fact: 'Identity of news index and contract index is unconfirmed.',
          query: null,
          scope: 'company',
          materialId: loan.materialId,
        },
      ],
    },
  };
}

function conditionalScenario() {
  const draft = contradiction();
  const assessment = draft.assessment;
  const consequence = assessment?.conditions[1];
  if (!assessment || !consequence) throw new Error('Missing fixture consequence');
  consequence.assertion = 'conditional';
  consequence.status = 'unknown';
  draft.impact = {
    metric: 'expense_delta',
    amountBasis: 'qualitative',
    economicObjectId: null,
    evidenceStatus: 'conditional',
    importance: 1,
    urgency: 1,
    novelty: 1,
  };
  assessment.applicability = {
    status: 'established',
    basis: 'documented_exposure',
    sourceRefs: [loan],
    explanation: 'Documented loan exposure with an unresolved index identity.',
    assumptions: ['The reference index is index A.'],
  };
  return { draft, assessment, consequence };
}

describe('structured evidence dependency consistency', () => {
  it('rejects an unconditional supported consequence with an unknown necessary prerequisite', () => {
    expect(() => validateReferences([contradiction()], context)).toThrowError(
      'A supported derived condition requires supported evidence dependencies.',
    );
  });

  it('retains independent supported principal evidence despite an unrelated unknown', () => {
    const draft = contradiction();
    const assessment = draft.assessment;
    if (!assessment) throw new Error('Missing fixture assessment');
    assessment.conditions = assessment.conditions.filter((_, index) => index !== 1);
    expect(() => validateReferences([draft], context)).not.toThrow();
    expect(assessment.conditions[1]?.status).toBe('supported');
  });

  it('accepts the consequence when the necessary index identity is established', () => {
    const draft = contradiction();
    const identity = draft.assessment?.conditions[0];
    if (!identity || !draft.assessment) throw new Error('Missing fixture prerequisite');
    identity.status = 'supported';
    draft.assessment.unknowns = [];
    draft.status = 'announced';
    draft.conclusion = 'The matching contract index changes the contractual rate from 12 to 14.';
    expect(() => validateReferences([draft], context)).not.toThrow();
  });

  it('retains an explicitly hypothetical scenario without claiming the rate change occurred', () => {
    const draft = contradiction();
    const consequence = draft.assessment?.conditions[1];
    if (!consequence) throw new Error('Missing fixture consequence');
    consequence.predicate =
      'If the contract uses index A, its contractual rate would rise from 12 to 14 percent.';
    consequence.status = 'unknown';
    consequence.assertion = 'conditional';
    draft.status = 'conditional';
    draft.impact = {
      metric: 'expense_delta',
      amountBasis: 'qualitative',
      economicObjectId: null,
      evidenceStatus: 'conditional',
      importance: 1,
      urgency: 1,
      novelty: 1,
    };
    if (!draft.assessment) throw new Error('Missing fixture assessment');
    draft.assessment.applicability = {
      status: 'established',
      basis: 'documented_exposure',
      sourceRefs: [loan],
      explanation: 'A company loan exposure is documented; index identity is unconfirmed.',
      assumptions: ['The contract reference index is index A.'],
    };
    draft.conclusion = 'Conditional scenario only; index identity remains unconfirmed.';
    expect(() => validateReferences([draft], context)).not.toThrow();
  });

  it('keeps absent historical metadata absent on parsing and validation', () => {
    const legacy = {
      conditions: [
        {
          fact: 'Legacy fact',
          predicate: 'Legacy predicate',
          status: 'supported',
          sourceRefs: [loan],
        },
      ],
      unknowns: [
        { fact: 'Legacy missing fact', query: null, scope: 'company', materialId: loan.materialId },
      ],
    };
    const parsed = assessmentSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(() => validateEvidenceDependencies(parsed, 'unknown')).not.toThrow();
    expect(JSON.stringify(parsed)).not.toContain('dependsOn');
  });

  it('retains typed dependency metadata through shared assessment parsing', () => {
    const assessment = contradiction().assessment;
    expect(assessmentSchema.parse(assessment)).toEqual(assessment);
  });

  it('requires metadata on every new native condition and unknown', () => {
    const draft = contradiction();
    const assessment = draft.assessment;
    if (!assessment) throw new Error('Missing fixture assessment');
    const conditions = assessment.conditions.map(({ sourceRefs: _refs, ...condition }) => ({
      ...condition,
      sourceHandles: ['s0'],
    }));
    const native = {
      objectHandle: 'o0',
      assessment: { conditions, unknowns: assessment.unknowns },
      question: {
        mechanism: 'financing_cost',
        frame: 'event_only',
        unit: 'qualitative',
        targetPeriod: 'unknown',
        baselinePeriod: null,
        basis: 'qualitative',
      },
      conclusion: draft.conclusion,
      status: 'unknown',
      sourceHandles: ['s0'],
      impact: {
        metric: 'risk',
        amountBasis: 'qualitative',
        economicObjectHandle: null,
        evidenceStatus: 'unknown',
        importance: 1,
        urgency: 1,
        novelty: 1,
      },
    };
    const schema = companyResultSchema(['o0'], ['s0']);
    expect(v.safeParse(schema, { drafts: [native] }).success).toBe(true);
    const unannotated = conditions.map(
      ({ id: _id, assertion: _assertion, dependsOn: _deps, ...condition }) => condition,
    );
    expect(
      v.safeParse(schema, {
        drafts: [{ ...native, assessment: { ...native.assessment, conditions: unannotated } }],
      }).success,
    ).toBe(false);
    const unidentified = assessment.unknowns.map(({ id: _id, ...unknown }) => unknown);
    expect(
      v.safeParse(schema, {
        drafts: [{ ...native, assessment: { ...native.assessment, unknowns: unidentified } }],
      }).success,
    ).toBe(false);
  });

  it.each([
    'supported_status',
    'unknown_impact',
    'no_assumptions',
    'unknown_exposure',
    'profile_exposure',
  ])('rejects invalid conditional claim: %s', (kind) => {
    const { draft, assessment, consequence } = conditionalScenario();
    if (kind === 'supported_status') consequence.status = 'supported';
    if (kind === 'unknown_impact' && draft.impact) draft.impact.evidenceStatus = 'unknown';
    if (!assessment.applicability) throw new Error('Missing fixture applicability');
    if (kind === 'no_assumptions') assessment.applicability.assumptions = [];
    if (kind === 'unknown_exposure') assessment.applicability.status = 'unknown';
    if (kind === 'profile_exposure') assessment.applicability.basis = 'profile_signal';
    expect(() => validateReferences([draft], context)).toThrowError(
      'Conditional evidence requires an unresolved scenario on established exposure with explicit assumptions.',
    );
  });

  it.each(['unknown_node', 'transitive_unknown', 'contradicted'])(
    'rejects supported inference with %s prerequisite',
    (kind) => {
      const draft = contradiction();
      const assessment = draft.assessment;
      const identity = assessment?.conditions[0];
      const effect = assessment?.conditions[1];
      if (!assessment || !identity || !effect) throw new Error('Missing fixture graph');
      if (kind === 'unknown_node') effect.dependsOn = ['missing_index_identity'];
      if (kind === 'contradicted') identity.status = 'contradicted';
      if (kind === 'transitive_unknown') {
        identity.assertion = 'derived';
        identity.status = 'supported';
        identity.dependsOn = ['missing_index_identity'];
      }
      expect(() => validateReferences([draft], context)).toThrowError(
        'A supported derived condition requires supported evidence dependencies.',
      );
    },
  );

  it.each([
    'missing_id',
    'duplicate_id',
    'invalid_id',
    'missing_edge',
    'duplicate_edge',
    'cycle',
    'observed_edge',
    'derived_no_edge',
    'partial',
    'too_many_edges',
  ])('rejects malformed declared graph: %s', (kind) => {
    const draft = contradiction();
    const assessment = draft.assessment;
    const identity = assessment?.conditions[0];
    const effect = assessment?.conditions[1];
    if (!assessment || !identity || !effect) throw new Error('Missing fixture graph');
    if (kind === 'missing_id') delete identity.id;
    if (kind === 'duplicate_id') identity.id = 'rate_change';
    if (kind === 'invalid_id') identity.id = 'invalid id';
    if (kind === 'missing_edge') effect.dependsOn = ['not_in_graph'];
    if (kind === 'duplicate_edge') effect.dependsOn = ['index_identity', 'index_identity'];
    if (kind === 'cycle') {
      identity.assertion = 'derived';
      identity.dependsOn = ['rate_change'];
    }
    if (kind === 'observed_edge') identity.dependsOn = ['principal'];
    if (kind === 'derived_no_edge') effect.dependsOn = [];
    if (kind === 'partial') delete identity.assertion;
    if (kind === 'too_many_edges') effect.dependsOn = Array.from({ length: 17 }, () => 'principal');
    expect(() => validateReferences([draft], context)).toThrowError(
      'Invalid evidence dependencies.',
    );
  });
});
