import { setProvider } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { describe, expect, it, vi } from 'vitest';
import { CompanyConsequencesAgent } from '../src/agents/news-analysis.ts';
import { createModelProvider } from '../src/config/model.ts';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import type {
  AnalysisReceipt,
  ContextBundle,
  ReasoningInput,
} from '../src/news-analysis/contracts/analysis.ts';
import { createNativeNewsReasoner } from '../src/news-analysis/reasoning/company-reasoner.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';
import { OwnerContextClient } from '../src/news-analysis/retrieval/owner-context.ts';
import { createLlmServer } from './helpers/llm-server.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const asOf = '2026-10-26T10:00:00.0000001Z';
const request = { companyId, newsMaterialId: 'news', newsVersionId: 'v1', asOf };
const rawFields = [
  'orgType',
  'okfsName',
  'companyAgeYearsGradation',
  'ecoMarkLabel',
  'mainOkvedCode',
  'mainOkvedName',
  'negativeMark',
  'amountWorkersFnsGradation',
  'amountWorkersSparkGradation',
  'clType',
  'clProductRkoMark',
  'clProductGarMark',
  'clProductLoaMark',
  'clProductLeaMark',
  'clProductDepMark',
  'clProductZppMark',
  'ftsFlag',
  'ftsCountryName',
  'factoringMark',
  'revenueCompany',
  'groupId',
  'city',
  'region',
];
const bankData = {
  ...Object.fromEntries(rawFields.map((field) => [field, null])),
  region: 'FixtureNorth',
  city: 'FixtureCity',
  mainOkvedCode: '01.11.01',
  revenueCompany: '00012345678901234567890.00100',
  clProductRkoMark: '01',
};
const profile = {
  companyId,
  revisionId: 'bank-capture-1',
  knownAt: asOf,
  bankData,
  sourceId: 'company-bank-profile',
  sourceRefs: [{ materialId: 'bank-snapshot', versionId: 'v1', contentHash: 'b'.repeat(64) }],
  provenance: {
    acquisition: 'event_payload',
    sourceUrl: null,
    retrievedAt: asOf,
    textCompleteness: 'full',
    originVersionId: null,
    locator: null,
  },
};
const bundle: ContextBundle = {
  news: {
    materialId: 'news',
    versionId: 'v1',
    contentHash: 'a'.repeat(64),
    sourceId: 'news-source',
    kind: 'news',
    title: 'Synthetic news',
    text: 'Synthetic event',
    knownAt: asOf,
    companyIds: [],
    bankProfileIds: [],
  },
  materials: [],
  coverage: {
    asOf,
    complete: true,
    characters: 100,
    materialCount: 1,
    companyMaterialCount: 0,
    marketMaterialCount: 0,
    previousNewsVersionCount: 0,
  },
};
const receipt: AnalysisReceipt = {
  ...request,
  analysisId: 'analysis',
  duplicate: false,
  resultSemantics: 'saved_analysis_revisions_not_latest_heads',
  completedAt: asOf,
  effects: [],
};

function setup(bank: unknown = profile, status = 200) {
  const ownerCalls: string[] = [];
  const owners = new OwnerContextClient(
    { companyUrl: 'http://company.test', userUrl: 'http://user.test', secret: 'synthetic-secret' },
    async (url) => {
      ownerCalls.push(String(url));
      if (String(url).includes('user.test'))
        throw new Error('Canonical company reasoning must not load a viewer role');
      return status === 404 ? new Response(null, { status: 404 }) : Response.json(bank, { status });
    },
  );
  const writes: unknown[] = [];
  const insights = new InsightClient(
    'http://insight.test',
    'synthetic-secret',
    async (url, init) => {
      if (String(url).endsWith('/session'))
        return Response.json({ receipt: null, previousEffects: [], stateVersion: 0 });
      if (String(url).endsWith('/prepare')) return Response.json({ drafts: [] });
      if (String(url).endsWith('/analyses')) {
        writes.push(JSON.parse(String(init?.body)));
        return Response.json(receipt);
      }
      throw new Error(`Unexpected synthetic request ${url}`);
    },
  );
  const analyze = vi.fn(async (_input: ReasoningInput) => []);
  return {
    owners,
    ownerCalls,
    writes,
    analyze,
    analyzer: new NewsAnalyzer({
      context: new ContextClient('http://context.test', 'synthetic-secret', async () =>
        Response.json(bundle),
      ),
      insights,
      owners,
      reasoner: { analyze },
    }),
  };
}

describe('owner declarations reach company reasoning without viewer arithmetic influence', () => {
  it('preserves the entire raw profile and exact provenance at the fixed asOf', async () => {
    const fixture = setup();
    const result = await fixture.analyzer.analyze(request);
    const input = fixture.analyze.mock.calls[0]?.[0];
    expect(input?.declaredContext?.bankProfile).toEqual(profile);
    expect(input?.declaredContext?.bankProfile?.bankData).toEqual(bankData);
    expect(Object.keys(input?.declaredContext?.bankProfile?.bankData ?? {})).toHaveLength(23);
    expect(JSON.stringify(input?.declaredContext)).not.toContain('viewer');
    expect(fixture.ownerCalls).toHaveLength(1);
    expect(result.reasoningInvoked).toBe(true);
    expect(fixture.writes).toHaveLength(1);
  });
  it('preserves unknowns when an undeployed owner route returns 404', async () => {
    const fixture = setup(null, 404);
    await expect(fixture.analyzer.analyze(request)).resolves.toMatchObject({
      analysisId: 'analysis',
    });
    expect(fixture.analyze.mock.calls[0]?.[0].declaredContext).toMatchObject({
      bankProfile: null,
      paymentActivity: null,
    });
  });
  it('fails before reasoning or canonical write on a future owner snapshot', async () => {
    const fixture = setup({
      ...profile,
      knownAt: '2026-10-26T10:00:00.0000002Z',
      provenance: { ...profile.provenance, retrievedAt: '2026-10-26T10:00:00.0000002Z' },
    });
    await expect(fixture.analyzer.analyze(request)).rejects.toMatchObject({
      code: 'DECLARED_CONTEXT_SCOPE',
    });
    expect(fixture.analyze).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });
  it('passes the declared block through the actual native assistant serialization using a fake provider', async () => {
    const fixture = setup();
    const declaredContext = await fixture.owners.company(companyId, asOf);
    const llm = await createLlmServer({ name: 'submit_news_analysis', arguments: { drafts: [] } });
    const runtime = await start({ agents: [CompanyConsequencesAgent], providers: [] });
    try {
      setProvider(
        createModelProvider({
          LLM_BASE_URL: llm.url,
          LLM_API_KEY: 'test-only-key',
          LLM_MODEL: 'test-model',
        }),
      );
      await createNativeNewsReasoner({}).analyze({
        request,
        context: structuredClone(bundle),
        previousEffects: [],
        declaredContext,
      });
      const prompt = llm.requests
        .flatMap((item) => item.messages)
        .find((message) => message.role === 'user');
      const text =
        typeof prompt?.content === 'string' ? prompt.content : JSON.stringify(prompt?.content);
      expect(text).toContain('FixtureNorth');
      expect(text).toContain('00012345678901234567890.00100');
      expect(text).toContain('bank-capture-1');
      expect(text).not.toContain('viewerContext');
    } finally {
      await runtime.stop();
      await llm.close();
    }
  });
});
