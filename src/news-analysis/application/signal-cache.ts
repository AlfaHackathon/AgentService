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
