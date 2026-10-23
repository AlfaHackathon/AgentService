import type { z } from 'zod';
import type { materialSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import { type NewsPlan, type Segment, segmentBatchSchema } from '../contracts/flow.ts';
import type { SignalInventory } from '../contracts/signals.ts';
import { instantAfter } from '../contracts/timestamps.ts';
import type { FlowContextClient } from '../retrieval/flow-clients.ts';
import { sourceKey } from '../retrieval/source-catalog.ts';
import { sourceUnits } from '../retrieval/source-units.ts';
import { validateSegmentPlan } from './segment-policy.ts';
import { cachedInventory } from './signal-cache.ts';
export async function analyzeSegmentBatch(
  context: FlowContextClient,
  reason: (
    news: z.infer<typeof materialSchema>,
    sources: z.infer<typeof materialSchema>[],
    segments: Segment[],
    asOf: string,
    inventories?: SignalInventory[],
  ) => Promise<NewsPlan>,
  news: z.infer<typeof materialSchema>,
  segments: Segment[],
  asOf: string,
  signalCache?: {
    inventories: SignalInventory[];
    extract: (sources: z.infer<typeof materialSchema>[]) => Promise<SignalInventory[]>;
    save: () => Promise<void>;
  },
) {
  const refs = new Map<string, { materialId: string; versionId: string; contentHash: string }>();
  let exhaustive = true;
  for (const segment of segments) {
    const found = await context.search(
      `${segment.labels.join('; ')}: отраслевой спрос продажи выпуск инвестиции издержки. ${news.title}`,
      asOf,
      true,
    );
    exhaustive &&= found.exhaustive;
    for (const hit of found.hits)
      for (const r of [...(hit.relatedVersions ?? []), ...hit.sourceRefs])
        refs.set(sourceKey(r), r);
  }
  const sources: z.infer<typeof materialSchema>[] = [];
  let omitted = 0;
  const bundles = new Map<
    string,
    Array<{ materialId: string; versionId: string; contentHash: string }>
  >();
  for (const ref of refs.values()) {
    const bundle = bundles.get(ref.materialId) ?? [];
    bundle.push(ref);
    bundles.set(ref.materialId, bundle);
  }
  let originalReads = 0;
  for (const refs of bundles.values()) {
    if (sources.length + refs.length > 16 || originalReads + refs.length > 64) {
      omitted += refs.length;
      continue;
    }
    const bundle: typeof sources = [];
    for (const ref of refs) {
      originalReads++;
      const s = await context.material(ref.materialId, ref.versionId);
      if (
        s.kind !== 'market' ||
        s.companyIds.length ||
        sourceKey(s) !== sourceKey(ref) ||
        instantAfter(s.knownAt, asOf)
      )
        throw new NewsAnalysisError(502, 'SEGMENT_SOURCE_SCOPE', 'Segment source is unavailable');
      bundle.push(s);
    }
    const candidateSources = [...sources, ...bundle];
    const candidateUnits = sourceUnits(candidateSources);
    if (
      JSON.stringify({ news, segments, sources: [...sources, ...bundle] }).length > 90000 ||
      candidateUnits.length > 64 ||
      JSON.stringify({
        news,
        segments,
        publicSources: candidateSources.map(({ text: _text, ...metadata }) => metadata),
        sourceUnits: candidateUnits,
      }).length > 90000
    ) {
      omitted += bundle.length;
      continue;
    }
    sources.push(...bundle);
  }
  let inventories: SignalInventory[] | undefined;
  if (signalCache) {
    const units = sourceUnits(sources);
    const missing = sources.filter(
      (s) =>
        !signalCache.inventories.some(
          (i) => sourceKey(i.sourceRef) === sourceKey(s) && cachedInventory(i, units),
        ),
    );
    for (const source of missing) {
      const added = await signalCache.extract([source]);
      if (
        added.length !== 1 ||
        added.some(
          (i) => sourceKey(source) !== sourceKey(i.sourceRef) || !cachedInventory(i, units),
        )
      )
        throw new NewsAnalysisError(
          422,
          'SIGNAL_INVENTORY',
          'Incomplete or foreign source signal inventory',
        );
      for (const item of added) {
        const index = signalCache.inventories.findIndex(
          (i) => sourceKey(i.sourceRef) === sourceKey(item.sourceRef),
        );
        if (index >= 0) signalCache.inventories[index] = item;
        else signalCache.inventories.push(item);
      }
      await signalCache.save();
    }
    inventories = sources.map((s) => {
      const inventory = signalCache.inventories.find(
        (i) => sourceKey(i.sourceRef) === sourceKey(s),
      );
      if (!inventory) throw new Error('Missing source inventory');
      return inventory;
    });
    // Independently cached extracts can be larger together than one fresh extract.
    // Admit whole material/version bundles and reserve 48k output + review overhead.
    const admitted: typeof sources = [];
    const admittedInventories: SignalInventory[] = [];
    for (const materialId of new Set(sources.map((s) => s.materialId))) {
      const bundle = sources.filter((s) => s.materialId === materialId);
      const bundleInventories = inventories.filter((i) => i.sourceRef.materialId === materialId);
      const candidate = [...admittedInventories, ...bundleInventories];
      const chars = JSON.stringify({
        news,
        segments: segments.map(({ key, labels }) => ({ key, labels })),
        publicSources: [...admitted, ...bundle].map(({ text: _text, ...s }) => s),
        sourceUnits: [],
        inventories: candidate,
      }).length;
      const inputBudget = 180000 - 48000 - 10000 - 2000;
      if (chars > inputBudget || candidate.flatMap((i) => i.signals).length > 128) {
        omitted += bundle.length;
        continue;
      }
      admitted.push(...bundle);
      admittedInventories.push(...bundleInventories);
    }
    sources.splice(0, sources.length, ...admitted);
    inventories = admittedInventories;
  }
  const plan = await reason(news, sources, segments, asOf, inventories);
  validateSegmentPlan(plan, segments, news, sources);
  return segmentBatchSchema.parse({
    coverageVersion: signalCache ? 4 : 3,
    segments,
    plan,
    sources: sources.map(({ materialId, versionId, contentHash }) => ({
      materialId,
      versionId,
      contentHash,
    })),
    omittedSources: omitted,
    retrievalExhaustive: exhaustive && omitted === 0,
  });
}
