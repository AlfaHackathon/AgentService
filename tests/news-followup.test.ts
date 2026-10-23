import { describe, expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import {
  analysisReceiptSchema,
  type ContextBundle,
  type EffectDraft,
} from '../src/news-analysis/contracts/analysis.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const asOf = '2026-10-22T10:00:00Z';
const news = {
  materialId: 'synthetic-news',
  versionId: '1',
  sourceId: 'fixture',
  kind: 'news' as const,
  title: 'Synthetic',
  text: 'Synthetic rate event',
  knownAt: asOf,
  companyIds: [],
  bankProfileIds: [],
  contentHash: 'a'.repeat(64),
};
const contract = {
  ...news,
  materialId: 'synthetic-contract',
  kind: 'company' as const,
  companyIds: [companyId],
  contentHash: 'b'.repeat(64),
};
const ref = (s: typeof news | typeof contract) => ({
  materialId: s.materialId,
  versionId: s.versionId,
  contentHash: s.contentHash,
});
const bundle: ContextBundle = {
  news,
  materials: [],
  coverage: {
    complete: false,
    materialCount: 1,
    companyMaterialCount: 0,
    marketMaterialCount: 0,
    previousNewsVersionCount: 0,
    characters: 100,
    asOf,
  },
};
function question(found: boolean): EffectDraft {
  return {
    effectKey: 'host-replaces-this',
    literalObjectRef: `company:${companyId}`,
    status: found ? 'observed' : 'unknown',
    conclusion: found
      ? 'Synthetic contractual condition found.'
      : 'Synthetic condition remains unknown.',
    sourceRefs: found ? [ref(news), ref(contract)] : [ref(news)],
    question: {
      mechanism: 'financing_cost',
      frame: 'absolute',
      unit: 'RUB',
      targetPeriod: '2026',
      baselinePeriod: null,
    },
    assessment: {
      conditions: [
        {
          fact: 'floating rate',
          predicate: 'rate resets with policy rate',
          status: found ? 'supported' : 'unknown',
          sourceRefs: found ? [ref(contract)] : [],
        },
      ],
      unknowns: found
        ? []
        : [
            {
              fact: 'floating rate clause',
              query: 'specific financing rate reset clause',
              scope: 'company',
              materialId: contract.materialId,
            },
          ],
    },
  };
}
function fixture(found: boolean, complete = false) {
  const context = new ContextClient('http://context.test', 'test'),
    insights = new InsightClient('http://insights.test', 'test');
  vi.spyOn(insights, 'prepare').mockImplementation(async (_request, drafts) =>
    drafts.map((draft) => ({ ...draft, expectedPreviousRevisionId: null })),
  );
  vi.spyOn(insights, 'findAnalysis').mockResolvedValue(null);
  vi.spyOn(insights, 'getState').mockResolvedValue({ effects: [], stateVersion: 0 });
  vi.spyOn(context, 'getContext').mockResolvedValue({
    ...bundle,
    coverage: { ...bundle.coverage, complete },
  });
  const follow = vi
    .spyOn(context, 'followUp')
    .mockResolvedValue(
      found
        ? { ...bundle, materials: [contract], coverage: { ...bundle.coverage, complete: true } }
        : bundle,
    );
  const analyze = vi.fn(async (input: { context: ContextBundle }) => [
    question(input.context.materials.some((m) => m.materialId === contract.materialId)),
  ]);
  const save = vi.spyOn(insights, 'saveAnalysis').mockImplementation(async (input) =>
    analysisReceiptSchema.parse({
      ...input,
      analysisId: 'fixture-analysis',
      duplicate: false,
      resultSemantics: 'saved_analysis_revisions_not_latest_heads',
      completedAt: asOf,
      effects: [],
    }),
  );
  return {
    analyzer: new NewsAnalyzer({ context, insights, reasoner: { analyze } }),
    follow,
    analyze,
    save,
  };
}
describe('bounded source follow-up in the service orchestrator', () => {
  it('does not present host follow-up as a native model tool call', async () => {
    const f = fixture(false);
    f.analyzer.dependencies.reasoner.retrievalMode = 'agent_tools';
    await f.analyzer.analyze({
      companyId,
      newsMaterialId: news.materialId,
      newsVersionId: '1',
      asOf,
    });
    expect(f.follow).not.toHaveBeenCalled();
    expect(f.analyze).toHaveBeenCalledOnce();
    expect(f.save).toHaveBeenCalledWith(
      expect.objectContaining({
        drafts: [expect.objectContaining({ status: 'unknown' })],
        retrievalTrace: [expect.objectContaining({ stopReason: 'agent_tools' })],
      }),
    );
  });
  it('rejects foreign or future follow-up originals before any second model call', async () => {
    const f = fixture(false);
    f.follow.mockResolvedValue({
      ...bundle,
      materials: [
        {
          ...contract,
          knownAt: '2026-10-23T10:00:00Z',
          companyIds: ['22222222-2222-4222-8222-222222222222'],
        },
      ],
    });
    await expect(
      f.analyzer.analyze({ companyId, newsMaterialId: news.materialId, newsVersionId: '1', asOf }),
    ).rejects.toMatchObject({ code: 'FOLLOWUP_SCOPE' });
    expect(f.analyze).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
  });
  it('retrieves an explicitly missing permitted original and reassesses the condition', async () => {
    const f = fixture(true);
    await f.analyzer.analyze({
      companyId,
      newsMaterialId: news.materialId,
      newsVersionId: '1',
      asOf,
    });
    expect(f.follow).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, asOf }),
      ['specific financing rate reset clause'],
      'company',
      ['synthetic-contract'],
    );
    expect(f.analyze).toHaveBeenCalledTimes(2);
    expect(f.save.mock.calls[0]?.[0].drafts[0]?.assessment?.conditions[0]?.status).toBe(
      'supported',
    );
    expect(f.save.mock.calls[0]?.[0].retrievalTrace?.[1]).toMatchObject({
      round: 1,
      retrievedSources: [ref(news), ref(contract)],
    });
  });
  it('stops on no new evidence and saves true unknown without fabricating a calculation', async () => {
    const f = fixture(false);
    await f.analyzer.analyze({
      companyId,
      newsMaterialId: news.materialId,
      newsVersionId: '1',
      asOf,
    });
    expect(f.follow).toHaveBeenCalledTimes(1);
    expect(f.analyze).toHaveBeenCalledTimes(1);
    const write = f.save.mock.calls[0]?.[0];
    expect(write?.drafts[0]?.status).toBe('unknown');
    expect(write?.drafts[0]?.calculation).toBeUndefined();
    expect(write?.retrievalTrace?.[1]?.stopReason).toBe('no_new_evidence');
  });
  it('makes no extra retrieval or model calls when the available corpus is already complete', async () => {
    const f = fixture(false, true);
    await f.analyzer.analyze({
      companyId,
      newsMaterialId: news.materialId,
      newsVersionId: '1',
      asOf,
    });
    expect(f.follow).not.toHaveBeenCalled();
    expect(f.analyze).toHaveBeenCalledTimes(1);
    expect(f.save.mock.calls[0]?.[0].retrievalTrace?.[0]?.stopReason).toBe(
      'available_corpus_exhausted',
    );
  });
});
