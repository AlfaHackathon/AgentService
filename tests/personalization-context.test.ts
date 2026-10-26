import { describe, expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { validateReferences } from '../src/news-analysis/application/draft-validation.ts';
import type {
  ContextBundle,
  EffectDraft,
  ReasoningInput,
} from '../src/news-analysis/contracts/analysis.ts';
import { companyProfileSchema } from '../src/news-analysis/contracts/flow.ts';
import { CompanyClient } from '../src/news-analysis/retrieval/company-client.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { economicObjectCatalog } from '../src/news-analysis/retrieval/economic-objects.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';
import { objectCatalog } from '../src/news-analysis/retrieval/source-catalog.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const asOf = '2026-10-26T12:00:00Z';
const values = {
  region: 'Synthetic Region A',
  industrySections: ['C'],
  revenue: { amount: '9007199254740991.01', currency: null, period: null },
  countOfEmployees: null,
};
const snapshot = {
  materialId: 'synthetic-declared',
  versionId: 'capture-1',
  contentHash: 'd'.repeat(64),
  sourceId: 'company-operational-declared-profile',
  kind: 'company' as const,
  title: 'Declared operational snapshot',
  text: JSON.stringify({ companyId, ...values }),
  knownAt: asOf,
  companyIds: [companyId],
  bankProfileIds: [],
};
const ref = {
  materialId: snapshot.materialId,
  versionId: snapshot.versionId,
  contentHash: snapshot.contentHash,
};
const profile = {
  companyId,
  revisionId: 'capture-1',
  bankProfileId: null,
  name: 'Synthetic company',
  description: 'Declared operational profile',
  industryCodes: [],
  exposures: [],
  knownAt: asOf,
  sourceRefs: [ref],
  declaredProfile: { ...values, sourceRefs: [ref] },
};
const news = {
  ...snapshot,
  materialId: 'synthetic-news',
  versionId: 'v1',
  sourceId: 'synthetic-news',
  kind: 'news' as const,
  text: 'Manufacturing support in Synthetic Region A',
  companyIds: [],
  contentHash: 'a'.repeat(64),
};
const context: ContextBundle = {
  news,
  materials: [],
  coverage: {
    complete: true,
    materialCount: 1,
    companyMaterialCount: 0,
    marketMaterialCount: 0,
    previousNewsVersionCount: 0,
    characters: 100,
    asOf,
  },
};
const request = { companyId, newsMaterialId: news.materialId, newsVersionId: news.versionId, asOf };

function setup() {
  const state = { profile: structuredClone(profile), snapshot: structuredClone(snapshot) };
  const payloads: unknown[] = [];
  const analyze = vi.fn(async (_input: ReasoningInput) => []);
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/knowledge/companies/')) return Response.json(state.profile);
    if (path.includes('/material-versions/')) return Response.json(state.snapshot);
    if (path.endsWith('/context')) return Response.json(context);
    if (path.endsWith('/analyses/session'))
      return Response.json({ receipt: null, previousEffects: [], stateVersion: 0 });
    if (path.endsWith('/analyses/prepare')) return Response.json({ drafts: [] });
    if (path.endsWith('/analyses')) {
      payloads.push(JSON.parse(String(options?.body)));
      return Response.json({
        ...request,
        analysisId: 'synthetic-analysis',
        duplicate: false,
        resultSemantics: 'saved_analysis_revisions_not_latest_heads',
        completedAt: asOf,
        effects: [],
      });
    }
    throw new Error(`Unexpected fixture request ${path}`);
  };
  const analyzer = new NewsAnalyzer({
    context: new ContextClient('http://fixture/context-service', 'fixture-secret', fetcher),
    insights: new InsightClient('http://fixture/insight-service', 'fixture-secret', fetcher),
    companies: new CompanyClient('http://fixture/company-service', 'fixture-secret', fetcher),
    reasoner: { analyze },
  });
  return { state, analyzer, analyze, payloads };
}

describe('declared company context through the analysis seam', () => {
  it('retains legacy nulls and exact decimal strings without inferring currency or period', () => {
    expect(companyProfileSchema.parse(profile).declaredProfile).toEqual(profile.declaredProfile);
    const { declaredProfile: _declared, ...legacy } = profile;
    expect(companyProfileSchema.parse(legacy).declaredProfile ?? null).toBeNull();
  });

  it.each(['Synthetic Region A', 'Synthetic Region B'])(
    'delivers actual regional context %s and A–U sections to reasoning without rewriting the news',
    async (region) => {
      const s = setup();
      s.state.profile.declaredProfile.region = region;
      s.state.snapshot.text = JSON.stringify({ companyId, ...values, region });
      await s.analyzer.analyze(request);
      const input = s.analyze.mock.calls[0]?.[0];
      expect(input?.companyProfile?.declaredProfile).toEqual({
        ...profile.declaredProfile,
        region,
      });
      expect(input?.context.news.text).toBe(news.text);
      expect(input?.context.materials).toContainEqual(s.state.snapshot);
      expect(s.payloads).toEqual([
        expect.not.objectContaining({
          companyProfile: expect.anything(),
          viewer: expect.anything(),
        }),
      ]);
    },
  );

  it.each(['future', 'foreign', 'tampered'])(
    'rejects %s snapshot before reasoning or save',
    async (problem) => {
      const s = setup();
      if (problem === 'future') s.state.snapshot.knownAt = '2026-10-27T00:00:00Z';
      if (problem === 'foreign')
        s.state.snapshot.companyIds = ['22222222-2222-4222-8222-222222222222'];
      if (problem === 'tampered')
        s.state.snapshot.text = JSON.stringify({ companyId, ...values, region: 'Other region' });
      await expect(s.analyzer.analyze(request)).rejects.toMatchObject({
        code: 'DECLARED_PROFILE_SOURCE',
      });
      expect(s.analyze).not.toHaveBeenCalled();
      expect(s.payloads).toEqual([]);
    },
  );

  it('never promotes declared text to contractual objects or documentary exposure', () => {
    const declared = { ...snapshot, text: 'contract SYNTHETIC-LOAN-001 budget:2027' };
    expect(economicObjectCatalog([declared], companyId, asOf)).toEqual([]);
    expect(objectCatalog([declared], companyId)).toHaveLength(1);
    const draft: EffectDraft = {
      effectKey: 'synthetic-profile',
      literalObjectRef: `company:${companyId}`,
      conclusion: 'Exposure not established',
      status: 'unknown',
      sourceRefs: [news, ref],
      assessment: {
        conditions: [],
        unknowns: [],
        applicability: {
          status: 'established',
          basis: 'documented_exposure',
          explanation: 'Declared profile is insufficient',
          assumptions: [],
          sourceRefs: [ref],
        },
      },
    };
    expect(() => validateReferences([draft], { ...context, materials: [declared] })).toThrowError(
      expect.objectContaining({ code: 'DECLARED_PROFILE_EXPOSURE' }),
    );
    if (!draft.assessment?.applicability) throw new Error('Missing fixture applicability');
    draft.assessment.applicability.basis = 'profile_signal';
    draft.assessment.applicability.status = 'unknown';
    expect(() => validateReferences([draft], { ...context, materials: [declared] })).not.toThrow();
  });
  it.each([{ sourceRefs: [] }, { sourceRefs: [news] }])(
    'does not bypass the profile exposure guard with incomplete applicability citations %j',
    ({ sourceRefs }) => {
      const draft: EffectDraft = {
        effectKey: 'synthetic-profile',
        literalObjectRef: `company:${companyId}`,
        conclusion: 'Unsupported declared financial claim',
        status: 'supported',
        sourceRefs: [news, ref],
        assessment: {
          conditions: [],
          unknowns: [],
          applicability: {
            status: 'established',
            basis: 'documented_exposure',
            explanation: 'Insufficient',
            assumptions: [],
            sourceRefs,
          },
        },
      };
      expect(() => validateReferences([draft], { ...context, materials: [snapshot] })).toThrowError(
        expect.objectContaining({ code: 'DECLARED_PROFILE_EXPOSURE' }),
      );
    },
  );
});
