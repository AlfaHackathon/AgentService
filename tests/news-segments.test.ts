import { expect, it, vi } from 'vitest';
import { analyzeSegmentBatch } from '../src/news-analysis/application/segment-analysis.ts';
import {
  refreshSegmentBatches,
  validateSegmentPlan,
} from '../src/news-analysis/application/segment-policy.ts';
import { materialSchema } from '../src/news-analysis/contracts/analysis.ts';
import {
  checkpointSchema,
  type NewsPlan,
  newsPlanSchema,
  segmentPlanSchema,
} from '../src/news-analysis/contracts/flow.ts';
import type { SignalInventory } from '../src/news-analysis/contracts/signals.ts';
import { extractInventories } from '../src/news-analysis/reasoning/source-signals.ts';
import { FlowContextClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { sourceUnits } from '../src/news-analysis/retrieval/source-units.ts';

const at = '2026-10-23T10:00:00Z',
  a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
const news = materialSchema.parse({
  materialId: 'news',
  versionId: '1',
  sourceId: 'fixture',
  kind: 'news',
  title: 'fixture',
  text: 'fixture',
  knownAt: at,
  companyIds: [],
  bankProfileIds: [],
  contentHash: 'a'.repeat(64),
});
const market = { ...news, kind: 'market' as const, materialId: 'bank' };
const ref = (s: typeof news) => ({
  materialId: s.materialId,
  versionId: s.versionId,
  contentHash: s.contentHash,
});
const segments = [
  { key: 'okved2:45', labels: ['Car retail'], companyIds: [a, b], profileRefs: [ref(news)] },
];
const plan: NewsPlan = {
  sourceCoverage: [
    {
      unitId: sourceUnits([market])[0]?.unitId ?? 'missing-fixture',
      disposition: 'used',
      signals: [],
      insightIndexes: [0],
      reason: 'Fixture evidence',
    },
  ],
  eventSummary: 'fixture',
  queries: ['fixture'],
  generalInsights: [
    {
      title: 'sector',
      conclusion: 'Conditional demand risk; own sales unknown',
      mechanism: 'demand',
      applicability: ['Car exposure'],
      exclusions: ['Other niches'],
      unknowns: ['Company sales'],
      sourceRefs: [ref(news), ref(market)],
    },
  ],
  segmentCoverage: [{ segmentKey: 'okved2:45', insightIndexes: [0], reason: 'Fixture source' }],
};
it('rejects uncovered segments, out of range indices and foreign sources', () => {
  expect(() =>
    validateSegmentPlan({ ...plan, segmentCoverage: [] }, segments, news, [market]),
  ).toThrow('Segment');
  expect(() =>
    validateSegmentPlan(
      {
        ...plan,
        segmentCoverage: [{ segmentKey: 'okved2:45', insightIndexes: [1], reason: 'bad' }],
      },
      segments,
      news,
      [market],
    ),
  ).toThrow('Segment');
  expect(() => validateSegmentPlan(plan, segments, news, [])).toThrow('source unit');
  expect(() => validateSegmentPlan(plan, segments, news, [market])).not.toThrow();
});
it('retrieves and reasons once for two companies and rejects restricted originals before model', async () => {
  const context = new FlowContextClient('http://fixture', 'test');
  vi.spyOn(context, 'search').mockResolvedValue({
    hits: [
      { companyId: a, sourceRefs: [ref(market)], score: 1, materialId: 'bank', versionId: '1' },
    ],
    mode: 'fixture',
    reranker: 'none',
    exhaustive: false,
    candidatesExamined: 1,
  });
  const read = vi.spyOn(context, 'material').mockResolvedValue(market);
  const reason = vi.fn(async () => plan);
  const result = await analyzeSegmentBatch(context, reason, news, segments, at);
  expect(context.search).toHaveBeenCalledTimes(1);
  expect(reason).toHaveBeenCalledTimes(1);
  expect(result.segments[0]?.companyIds).toEqual([a, b]);
  expect(result.retrievalExhaustive).toBe(false);
  read.mockResolvedValue({ ...market, companyIds: [a] });
  await expect(analyzeSegmentBatch(context, reason, news, segments, at)).rejects.toThrow(
    'unavailable',
  );
  expect(reason).toHaveBeenCalledTimes(1);
});

it('refreshes late membership without model work, but invalidates changed niche labels', () => {
  const first = segments.map((segment) => ({ ...segment, companyIds: [a] }));
  const batch = {
    coverageVersion: 3 as const,
    segments: first,
    plan,
    sources: [ref(market)],
    omittedSources: 0,
    retrievalExhaustive: false,
  };
  expect(refreshSegmentBatches([batch], segments)[0]?.segments[0]?.companyIds).toEqual([a, b]);
  const changed = segments.map((segment) => ({ ...segment, labels: ['Parts wholesaler'] }));
  expect(refreshSegmentBatches([batch], changed)).toEqual([]);
});
it.each(['original', 'repeated table headers'])(
  'omits a whole correction bundle exceeding the %s budget',
  async (kind) => {
    const context = new FlowContextClient('http://fixture', 'test');
    const v2 = {
      ...market,
      versionId: '2',
      text:
        kind === 'original'
          ? 'x'.repeat(91000)
          : `${'Header'.repeat(1000)} | Actual | Forecast\n${'Metric | 1 | 2\n'.repeat(50)}`,
    };
    vi.spyOn(context, 'search').mockResolvedValue({
      hits: [
        {
          companyId: a,
          sourceRefs: [ref(market)],
          relatedVersions: [ref(v2)],
          score: 1,
          materialId: 'bank',
          versionId: '1',
        },
      ],
      mode: 'fixture',
      reranker: 'none',
      exhaustive: false,
      candidatesExamined: 1,
    });
    vi.spyOn(context, 'material').mockImplementation(async (_id, v) => (v === '2' ? v2 : market));
    const noSignal = {
      ...plan,
      sourceCoverage: [],
      generalInsights: [],
      segmentCoverage: [
        { segmentKey: 'okved2:45', insightIndexes: [], reason: 'Originals unavailable' },
      ],
    };
    const reason = vi.fn(async (_news: typeof news, _sources: (typeof news)[]) => noSignal);
    const result = await analyzeSegmentBatch(context, reason, news, segments, at);
    expect(reason.mock.calls[0]?.[1]).toEqual([]);
    expect(result.omittedSources).toBe(2);
    expect(result.retrievalExhaustive).toBe(false);
  },
);

it('does not hydrate bundles known to exceed the original limit', async () => {
  const context = new FlowContextClient('http://fixture', 'test');
  const refs = Array.from({ length: 17 }, (_, i) => ({ ...ref(market), versionId: String(i) }));
  vi.spyOn(context, 'search').mockResolvedValue({
    hits: [{ companyId: a, sourceRefs: refs, score: 1, materialId: 'bank', versionId: '1' }],
    mode: 'fixture',
    reranker: 'none',
    exhaustive: false,
    candidatesExamined: 17,
  });
  const read = vi.spyOn(context, 'material');
  const reason = vi.fn(async () => ({
    ...plan,
    sourceCoverage: [],
    generalInsights: [],
    segmentCoverage: [{ segmentKey: 'okved2:45', insightIndexes: [], reason: 'Bundle too large' }],
  }));
  const result = await analyzeSegmentBatch(context, reason, news, segments, at);
  expect(read).not.toHaveBeenCalled();
  expect(result.omittedSources).toBe(17);
});

it('accounts for table rows separately with exact column headers and lossless text', () => {
  const text =
    'Narrative before\r\nMetric | Actual | Forecast\r\n--- | --- | ---\r\nSales | 7 | 4\r\nPay | 8 | 6\r\nNarrative after\nOther | Old | New\nRate | 3 | 5\nEnd';
  const units = sourceUnits([{ ...market, text }]);
  expect(units.map((u) => u.text).join('')).toBe(text);
  expect(units.filter((u) => u.tableHeader).map((u) => [u.tableHeader, u.text])).toEqual([
    [
      'Metric | Actual | Forecast',
      'Metric | Actual | Forecast\r\n--- | --- | ---\r\nSales | 7 | 4\r\n',
    ],
    ['Metric | Actual | Forecast', 'Pay | 8 | 6\r\n'],
    ['Other | Old | New', 'Other | Old | New\nRate | 3 | 5\n'],
  ]);
  expect(new Set(units.map((u) => u.unitId)).size).toBe(units.length);
  expect(units.every((u) => text.slice(u.start, u.end) === u.text)).toBe(true);
});

it('recognizes two-column tables without outer pipes', () => {
  const text = 'Before\nIndicator | Forecast\nDemand | +3%\nProfit | +2%\nAfter';
  const units = sourceUnits([{ ...market, text }]);
  expect(units.map((u) => u.text).join('')).toBe(text);
  expect(units.filter((u) => u.tableHeader)).toHaveLength(2);
  expect(
    units.filter((u) => u.tableHeader).every((u) => u.tableHeader === 'Indicator | Forecast'),
  ).toBe(true);
});

it('accounts for every exact source window and rejects fake coverage or unrelated citations', () => {
  const long = { ...market, text: `${'a'.repeat(2500)}\n${'b'.repeat(2600)}` };
  const units = sourceUnits([long]);
  expect(units.map((u) => u.text).join('')).toBe(long.text);
  expect(units.every((u) => u.text.length <= 2400)).toBe(true);
  const complete = {
    ...plan,
    sourceCoverage: units.map((u) => ({
      unitId: u.unitId,
      disposition: 'used' as const,
      signals: [],
      insightIndexes: [0],
      reason: 'Fixture',
    })),
  };
  expect(() => validateSegmentPlan(complete, segments, news, [long])).not.toThrow();
  expect(() =>
    validateSegmentPlan(
      { ...complete, sourceCoverage: complete.sourceCoverage.slice(1) },
      segments,
      news,
      [long],
    ),
  ).toThrow('every source unit');
  expect(() =>
    validateSegmentPlan(
      {
        ...complete,
        sourceCoverage: complete.sourceCoverage.map((r) => ({ ...r, unitId: 'invented' })),
      },
      segments,
      news,
      [long],
    ),
  ).toThrow('every source unit');
  expect(() =>
    validateSegmentPlan(
      {
        ...complete,
        generalInsights: complete.generalInsights.map((i) => ({ ...i, sourceRefs: [ref(news)] })),
      },
      segments,
      news,
      [long],
    ),
  ).toThrow('every source unit');
  expect(() =>
    validateSegmentPlan(
      {
        ...complete,
        sourceCoverage: complete.sourceCoverage.map((r) => ({
          ...r,
          disposition: 'background' as const,
        })),
      },
      segments,
      news,
      [long],
    ),
  ).toThrow('every source unit');
});
it('allows multiple mechanisms per segment without widening the general planner output budget', () => {
  const insight = plan.generalInsights[0];
  if (!insight) throw new Error('Missing fixture');
  const expanded = {
    ...plan,
    generalInsights: Array.from({ length: 9 }, () => insight),
  };
  expect(segmentPlanSchema.safeParse(expanded).success).toBe(true);
  expect(newsPlanSchema.safeParse(expanded).success).toBe(false);
});
it('invalidates legacy segment batches with no source accounting', () => {
  const { sourceCoverage: _coverage, ...legacy } = plan;
  expect(
    refreshSegmentBatches(
      [
        {
          segments,
          plan: legacy,
          sources: [ref(market)],
          omittedSources: 0,
          retrievalExhaustive: false,
        },
      ],
      segments,
    ),
  ).toEqual([]);
});

it('decodes persisted v2 checkpoints before invalidating their old window coverage', () => {
  const checkpoint = checkpointSchema.parse({
    segmentBatches: [
      {
        coverageVersion: 2,
        segments,
        plan,
        sources: [ref(market)],
        omittedSources: 0,
        retrievalExhaustive: false,
      },
    ],
  });
  expect(checkpoint.segmentBatches).toHaveLength(1);
  expect(refreshSegmentBatches(checkpoint.segmentBatches, segments)).toEqual([]);
});

it('persists one source extraction and reuses it for a second segment batch, invalidating changed versions', async () => {
  const context = new FlowContextClient('http://fixture', 'test');
  vi.spyOn(context, 'search').mockResolvedValue({
    hits: [
      { companyId: a, sourceRefs: [ref(market)], score: 1, materialId: 'bank', versionId: '1' },
    ],
    mode: 'fixture',
    reranker: 'none',
    exhaustive: true,
    candidatesExamined: 1,
  });
  vi.spyOn(context, 'material').mockResolvedValue(market);
  const inventories: SignalInventory[] = [];
  const extract = vi.fn(async () =>
    extractInventories(
      {
        units: sourceUnits([market]).map((u) => ({
          unitId: u.unitId,
          disposition: 'background',
          reason: 'No independent economic fact',
          signals: [],
        })),
      },
      sourceUnits([market]),
    ),
  );
  const save = vi.fn(async () => {});
  const reason = vi.fn(async () => plan);
  await analyzeSegmentBatch(context, reason, news, segments, at, { inventories, extract, save });
  await analyzeSegmentBatch(context, reason, news, segments, at, { inventories, extract, save });
  expect(extract).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(reason.mock.calls).toHaveLength(2);
  expect(inventories).toHaveLength(1);
});

it('reserves output space for independently cached inventories and omits whole oversized bundles', async () => {
  const originals = [0, 1, 2, 3].map((i) => ({
    ...market,
    materialId: `oversized-${i}`,
    text: 'x'.repeat(1800),
  }));
  const inventories = originals.flatMap((source) =>
    extractInventories(
      {
        units: sourceUnits([source]).map((u) => ({
          unitId: u.unitId,
          disposition: 'signals',
          reason: 'Independent fixture',
          signals: Array.from({ length: 12 }, (_, i) => ({
            kind: 'observation',
            statement: String(i) + 'x'.repeat(790),
            quote: 'x'.repeat(1800),
            period: 'unknown',
            scope: `Independent industry fixture ${'s'.repeat(350)}`,
            mechanisms: ['demand'],
          })),
        })),
      },
      sourceUnits([source]),
    ),
  );
  const context = new FlowContextClient('http://fixture', 'test');
  vi.spyOn(context, 'search').mockResolvedValue({
    hits: originals.map((s) => ({
      companyId: a,
      sourceRefs: [ref(s)],
      score: 1,
      materialId: s.materialId,
      versionId: '1',
    })),
    mode: 'fixture',
    reranker: 'none',
    exhaustive: true,
    candidatesExamined: 4,
  });
  vi.spyOn(context, 'material').mockImplementation(async (id) => {
    const s = originals.find((s) => s.materialId === id);
    if (!s) throw new Error('Missing fixture');
    return s;
  });
  const reason = vi.fn(async (_news: typeof news, sources: Array<typeof news>) => ({
    ...plan,
    generalInsights: [],
    segmentCoverage: [
      { segmentKey: segments[0]?.key ?? 'missing', insightIndexes: [], reason: 'Fixture' },
    ],
    sourceCoverage: sourceUnits(sources).map((u) => ({
      unitId: u.unitId,
      signals: [],
      disposition: 'background' as const,
      reason: 'Fixture',
      insightIndexes: [],
    })),
  }));
  const extract = vi.fn(async () => inventories);
  const result = await analyzeSegmentBatch(context, reason, news, segments, at, {
    inventories,
    extract,
    save: async () => {},
  });
  expect(result.omittedSources).toBeGreaterThan(0);
  expect(result.retrievalExhaustive).toBe(false);
  expect(extract).not.toHaveBeenCalled();
  expect(result.sources.length).toBeLessThan(4);
});

it('keeps a completed source checkpoint when a later source fails and only retries the missing source', async () => {
  const originals = [market, { ...market, materialId: 'second-original' }];
  const context = new FlowContextClient('http://fixture', 'test');
  vi.spyOn(context, 'search').mockResolvedValue({
    hits: originals.map((s) => ({
      companyId: a,
      sourceRefs: [ref(s)],
      score: 1,
      materialId: s.materialId,
      versionId: s.versionId,
    })),
    mode: 'fixture',
    reranker: 'none',
    exhaustive: true,
    candidatesExamined: 2,
  });
  vi.spyOn(context, 'material').mockImplementation(async (id) => {
    const source = originals.find((s) => s.materialId === id);
    if (!source) throw new Error('Unknown fixture');
    return source;
  });
  let failSecond = true;
  const extract = vi.fn(async (sources: Array<typeof news>) => {
    if (sources[0]?.materialId === 'second-original' && failSecond)
      throw new Error('Fixture timeout');
    const units = sourceUnits(sources);
    return extractInventories(
      {
        units: units.map((u) => ({
          unitId: u.unitId,
          disposition: 'background',
          reason: 'Fixture',
          signals: [],
        })),
      },
      units,
    );
  });
  const inventories: SignalInventory[] = [],
    snapshots: string[][] = [];
  const cache = {
    inventories,
    extract,
    save: async () => {
      snapshots.push(inventories.map((i) => i.sourceRef.materialId));
    },
  };
  const reason = vi.fn(async (_news: typeof news, sources: Array<typeof news>) => ({
    ...plan,
    generalInsights: [],
    segmentCoverage: segments.map((s) => ({
      segmentKey: s.key,
      insightIndexes: [],
      reason: 'Fixture',
    })),
    sourceCoverage: sourceUnits(sources).map((u) => ({
      unitId: u.unitId,
      signals: [],
      disposition: 'background' as const,
      insightIndexes: [],
      reason: 'Fixture',
    })),
  }));
  await expect(analyzeSegmentBatch(context, reason, news, segments, at, cache)).rejects.toThrow(
    'Fixture timeout',
  );
  expect(snapshots).toEqual([[market.materialId]]);
  expect(reason).not.toHaveBeenCalled();
  failSecond = false;
  await analyzeSegmentBatch(context, reason, news, segments, at, cache);
  expect(extract.mock.calls.map(([sources]) => sources.map((s) => s.materialId))).toEqual([
    [market.materialId],
    ['second-original'],
    ['second-original'],
  ]);
  expect(inventories).toHaveLength(2);
  expect(reason).toHaveBeenCalledTimes(1);
});
