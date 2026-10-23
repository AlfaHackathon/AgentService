import type { z } from 'zod';
import type { Segment, segmentBatchSchema } from '../contracts/flow.ts';
import type { SignalInventory } from '../contracts/signals.ts';
import { sourceKey } from '../retrieval/source-catalog.ts';
import type { SourceUnit } from '../retrieval/source-units.ts';
export function cachedInventory(inventory: SignalInventory, units: SourceUnit[]): boolean {
  const own = units.filter((u) => sourceKey(u.sourceRef) === sourceKey(inventory.sourceRef));
  return (
    inventory.version === 1 &&
    own.length === inventory.units.length &&
    own.every((u) => inventory.units.some((r) => r.unitId === u.unitId)) &&
    inventory.signals.every((s) =>
      own.some(
        (u) =>
          u.unitId === s.unitId &&
          sourceKey(s.sourceRef) === sourceKey(u.sourceRef) &&
          u.text.includes(s.quote),
      ),
    )
  );
}

export function refreshSegmentBatches(
  batches: z.infer<typeof segmentBatchSchema>[],
  segments: Segment[],
  requireSignals = false,
) {
  const latest = new Map(segments.map((s) => [s.key, s]));
  return batches
    .filter(
      (b) =>
        (requireSignals
          ? b.coverageVersion === 4 && b.plan.signalCoverage !== undefined
          : b.coverageVersion === 3 || b.coverageVersion === 4) &&
        b.plan.sourceCoverage !== undefined &&
        b.segments.every(
          (s) => JSON.stringify(latest.get(s.key)?.labels) === JSON.stringify(s.labels),
        ),
    )
    .map((b) => ({ ...b, segments: b.segments.map((s) => latest.get(s.key) ?? s) }));
}
