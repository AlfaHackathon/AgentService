import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { mechanisms } from '../contracts/questions.ts';
import { sourceKey } from '../retrieval/source-catalog.ts';
import type { SourceUnit } from '../retrieval/source-units.ts';

// Bound output work as well as input size. Every original window stays intact.
export function signalBatches(units: SourceUnit[]): SourceUnit[][] {
  const batches: SourceUnit[][] = [];
  for (const unit of units) {
    const last = batches.at(-1);
    if (
      !last?.[0] ||
      last.length >= 6 ||
      sourceKey(last[0].sourceRef) !== sourceKey(unit.sourceRef) ||
      last.reduce((n, u) => n + u.text.length, 0) + unit.text.length > 4800
    )
      batches.push([unit]);
    else last.push(unit);
  }
  return batches;
}

// Models may reflow a PDF line. Accept whitespace changes only, then restore the
// exact original span; numbers, punctuation and OCR spelling must still match.
export function originalQuote(text: string, quote: string): string | undefined {
  if (text.includes(quote)) return quote;
  const words = quote.trim().split(/\s+/u);
  if (!words.length || !words[0]) return undefined;
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return text.match(new RegExp(pattern, 'u'))?.[0];
}

import { type SignalInventory, signalInventorySchema } from '../contracts/signals.ts';

const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));
export function signalExtractionSchema(unitIds: string[]) {
  return v.strictObject({
    units: v.pipe(
      v.array(
        v.strictObject({
          unitId: v.picklist(unitIds),
          disposition: v.picklist(['signals', 'background', 'unreadable']),
          reason: text(400),
          signals: v.pipe(
            v.array(
              v.strictObject({
                kind: v.picklist(['observation', 'forecast', 'hypothesis', 'unknown']),
                statement: text(800),
                quote: text(1800),
                period: text(200),
                scope: text(400),
                mechanisms: v.pipe(
                  v.array(v.picklist(mechanisms)),
                  v.minLength(1),
                  v.maxLength(12),
                ),
              }),
            ),
            v.maxLength(12),
          ),
        }),
      ),
      v.maxLength(64),
    ),
  });
}

export function signalReviewSchema(unitIds: string[]) {
  return v.strictObject({
    units: v.pipe(
      v.array(
        v.strictObject({
          unitId: v.picklist(unitIds),
          action: v.picklist(['keep', 'replace']),
          reason: text(400),
          replacement: v.nullable(signalExtractionSchema(unitIds)),
        }),
      ),
      v.maxLength(64),
    ),
  });
}

export function reviewInventories(data: unknown, units: SourceUnit[], draft: SignalInventory[]) {
  const review = v.parse(signalReviewSchema(units.map((u) => u.unitId)), data);
  if (
    review.units.length !== units.length ||
    new Set(review.units.map((u) => u.unitId)).size !== units.length
  )
    throw new Error('Review every supplied source unit exactly once');
  const rows = review.units.map((row) => {
    if (row.action === 'replace') {
      if (row.replacement?.units.length !== 1 || row.replacement.units[0]?.unitId !== row.unitId)
        throw new Error('Replacement must contain exactly its own source unit');
      return row.replacement.units[0];
    }
    if (row.replacement !== null) throw new Error('Keep requires null replacement');
    const unit = units.find((u) => u.unitId === row.unitId);
    const inventory = draft.find(
      (i) => unit && sourceKey(i.sourceRef) === sourceKey(unit.sourceRef),
    );
    const original = inventory?.units.find((u) => u.unitId === row.unitId);
    if (!original || !inventory) throw new Error('Missing original draft unit');
    return {
      ...original,
      reason: row.reason,
      signals: inventory.signals
        .filter((s) => s.unitId === row.unitId)
        .map(({ kind, statement, quote, period, scope, mechanisms }) => ({
          kind,
          statement,
          quote,
          period,
          scope,
          mechanisms,
        })),
    };
  });
  return extractInventories({ units: rows }, units);
}

// IDs and source identities are host-owned. A quote must exist in the immutable source window.
export function extractInventories(data: unknown, units: SourceUnit[]): SignalInventory[] {
  const parsed = v.parse(signalExtractionSchema(units.map((u) => u.unitId)), data);
  if (
    parsed.units.length !== units.length ||
    new Set(parsed.units.map((u) => u.unitId)).size !== units.length
  )
    throw new Error(
      `Account for each supplied source unit exactly once. Missing: ${units
        .filter((u) => !parsed.units.some((r) => r.unitId === u.unitId))
        .map((u) => u.unitId)
        .join(', ')}`,
    );
  const byId = new Map(units.map((u) => [u.unitId, u]));
  const inventories = new Map<string, SignalInventory>();
  for (const row of parsed.units) {
    const unit = byId.get(row.unitId);
    if (!unit) throw new Error('Unknown source unit');
    if ((row.disposition === 'signals') !== row.signals.length > 0)
      throw new Error(`Signals/disposition mismatch: ${row.unitId}`);
    const inventory = inventories.get(sourceKey(unit.sourceRef)) ?? {
      version: 1,
      sourceRef: unit.sourceRef,
      units: [],
      signals: [],
    };
    inventory.units.push({ unitId: row.unitId, disposition: row.disposition, reason: row.reason });
    for (const submitted of row.signals) {
      const quote = originalQuote(unit.text, submitted.quote);
      if (!quote)
        throw new Error(
          `Quote must be an exact substring of ${row.unitId}; do not reconstruct or fix OCR. Invalid quote: ${submitted.quote.slice(0, 160)}`,
        );
      const signal = { ...submitted, quote };
      const signalId = `sig_${createHash('sha256')
        .update(JSON.stringify([row.unitId, signal]))
        .digest('hex')
        .slice(0, 24)}`;
      if (inventory.signals.some((s) => s.signalId === signalId))
        throw new Error(`Duplicate signal in ${row.unitId}`);
      inventory.signals.push({
        ...signal,
        signalId,
        unitId: row.unitId,
        sourceRef: unit.sourceRef,
        ...(unit.tableHeader ? { tableHeader: unit.tableHeader } : {}),
      });
    }
    inventories.set(sourceKey(unit.sourceRef), inventory);
  }
  if ([...inventories.values()].reduce((n, i) => n + i.signals.length, 0) > 128)
    throw new Error('At most 128 distinct source signals per extraction batch');
  return [...inventories.values()].map((i) => signalInventorySchema.parse(i));
}
