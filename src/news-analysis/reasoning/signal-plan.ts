import * as v from 'valibot';
import type { NewsPlan } from '../contracts/flow.ts';
import type { SignalInventory } from '../contracts/signals.ts';
import { sourceKey } from '../retrieval/source-catalog.ts';
import { planResultSchema } from './agent-schemas.ts';

const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));
export function compactSignalPlan(plan: NewsPlan) {
  return {
    eventSummary: plan.eventSummary,
    queries: plan.queries,
    mechanisms: plan.mechanisms,
    signalCoverage: plan.signalCoverage
      ?.filter((row) => !row.insightIndexes.length)
      .map(({ insightIndexes: _indexes, ...row }) => row),
    generalInsights: plan.generalInsights.map(({ sourceRefs: _refs, ...insight }, index) => ({
      ...insight,
      segmentKeys: plan.segmentCoverage
        ?.filter((row) => row.insightIndexes.includes(index))
        .map((row) => row.segmentKey),
    })),
    segmentCoverage: plan.segmentCoverage?.map(({ insightIndexes: _indexes, ...row }) => row),
  };
}

export function patchSignalCoverage(
  draft: Record<string, unknown> | null,
  patch: Array<{ signalId: string; disposition: string; reason: string }>,
): Record<string, unknown> {
  if (!draft) throw new Error('Submit a full plan before repairing signal coverage');
  const previous = draft.signalCoverage as typeof patch;
  if (new Set(patch.map((row) => row.signalId)).size !== patch.length)
    throw new Error('Duplicate signal coverage patch');
  const rows = new Map(previous.map((row) => [row.signalId, row]));
  for (const row of patch) rows.set(row.signalId, row);
  return { ...draft, signalCoverage: [...rows.values()] };
}

export function signalPlanSchema(ids: string[], keys: string[]) {
  const { sourceRefs: _refs, ...fields } = planResultSchema.entries.generalInsights.item.entries;
  return v.strictObject({
    eventSummary: text(4000),
    queries: v.optional(v.pipe(v.array(text(2000)), v.maxLength(6)), []),
    mechanisms: planResultSchema.entries.mechanisms,
    signalCoverage: v.pipe(
      v.array(
        v.strictObject({
          signalId: v.picklist(ids),
          disposition: v.picklist(['used', 'merged', 'background', 'not_applicable', 'unreadable']),
          reason: text(700),
        }),
      ),
      v.maxLength(128),
    ),
    generalInsights: v.pipe(
      v.array(
        v.strictObject({
          ...fields,
          signalIds: v.pipe(v.array(v.picklist(ids)), v.minLength(1), v.maxLength(128)),
          segmentKeys: v.pipe(v.array(v.picklist(keys)), v.minLength(1), v.maxLength(8)),
          quality: v.strictObject({
            decisionQuestion: text(700),
            distinctContribution: text(700),
            priority: v.picklist(['high', 'medium', 'low']),
            novelty: v.picklist(['news_specific', 'source_context']),
          }),
        }),
      ),
      v.maxLength(24),
    ),
    segmentCoverage: v.optional(
      v.pipe(
        v.array(v.strictObject({ segmentKey: v.picklist(keys), reason: text(700) })),
        v.maxLength(8),
      ),
      [],
    ),
  });
}

export function normalizeSignalPlan(
  data: unknown,
  inventories: SignalInventory[],
  keys: string[],
  news: { materialId: string; versionId: string; contentHash: string },
): NewsPlan {
  const signals = inventories.flatMap((i) => i.signals);
  const byId = new Map(signals.map((s) => [s.signalId, s]));
  const model = v.parse(
    signalPlanSchema(
      signals.map((s) => s.signalId),
      keys,
    ),
    data,
  );
  const linked = new Set(model.generalInsights.flatMap((i) => i.signalIds));
  if (
    new Set(model.signalCoverage.map((s) => s.signalId)).size !== model.signalCoverage.length ||
    signals.some(
      (s) =>
        !linked.has(s.signalId) && !model.signalCoverage.some((r) => r.signalId === s.signalId),
    )
  )
    throw new Error(
      `Account for every signal exactly once. Keep the draft unchanged and submit {plan: null, coveragePatch: [{signalId, disposition, reason}, ...]} for missing signals, or submit {plan: correctedFullPlan, coveragePatch: null} if conclusions need changes. Missing: ${signals
        .filter(
          (s) =>
            !linked.has(s.signalId) && !model.signalCoverage.some((r) => r.signalId === s.signalId),
        )
        .map((s) => s.signalId)
        .join(', ')}`,
    );
  const coverage = signals.map((signal) => {
    const row = model.signalCoverage.find((r) => r.signalId === signal.signalId) ?? {
      signalId: signal.signalId,
      disposition: 'used' as const,
      reason: 'Linked to an accepted conclusion; host derives use from the individual signal ID.',
    };
    const insightIndexes = model.generalInsights.flatMap((i, index) =>
      i.signalIds.includes(row.signalId) ? [index] : [],
    );
    if (!insightIndexes.length && ['used', 'merged'].includes(row.disposition))
      return {
        ...row,
        disposition: 'background' as const,
        insightIndexes,
        reason:
          `No linked insight; individual source signal retained, not covered by a sibling. ${row.reason}`.slice(
            0,
            700,
          ),
      };
    return { ...row, insightIndexes };
  });
  const conflicts = coverage.filter(
    (row) => ['used', 'merged'].includes(row.disposition) !== row.insightIndexes.length > 0,
  );
  if (conflicts.length)
    throw new Error(
      `These signals ARE linked to conclusions but have conflicting excluded/background/unreadable dispositions: ${conflicts.map((r) => `${r.signalId}=${r.disposition}, linkedInsightIndexes=[${r.insightIndexes.join(',')}]`).join('; ')}. If those conclusions actually contain the signals, set disposition=used with coveragePatch. Otherwise submit a full plan removing the incorrect links. Repeating background/not_applicable/unreadable cannot repair an existing link.`,
    );
  const identities = new Set<string>();
  for (const insight of model.generalInsights) {
    const identity = JSON.stringify([
      [...insight.signalIds].sort(),
      [...insight.segmentKeys].sort(),
      insight.mechanism,
    ]);
    if (identities.has(identity))
      throw new Error('Duplicate signal/segment/mechanism conclusions must be merged');
    identities.add(identity);
  }
  return {
    ...model,
    generalInsights: model.generalInsights.map(({ segmentKeys: _keys, ...i }) => ({
      ...i,
      sourceRefs: [
        ...new Map(
          [
            news,
            ...i.signalIds.map((id) =>
              (() => {
                const signal = byId.get(id);
                if (!signal) throw new Error('Unknown signal');
                return signal.sourceRef;
              })(),
            ),
          ].map((r) => [sourceKey(r), r]),
        ).values(),
      ],
    })),
    signalCoverage: coverage,
    sourceCoverage: inventories.flatMap((inv) =>
      inv.units.map((unit) => {
        const own = inv.signals.filter((s) => s.unitId === unit.unitId);
        const insightIndexes = model.generalInsights.flatMap((i, index) =>
          own.some((s) => i.signalIds.includes(s.signalId)) ? [index] : [],
        );
        return {
          unitId: unit.unitId,
          signals: own.map((s) => `${s.kind}: ${s.statement}`.slice(0, 600)),
          disposition: insightIndexes.length
            ? ('used' as const)
            : unit.disposition === 'unreadable'
              ? ('unreadable' as const)
              : ('background' as const),
          insightIndexes,
          reason: unit.reason,
        };
      }),
    ),
    segmentCoverage: keys
      .map((key) => ({
        segmentKey: key,
        reason:
          model.segmentCoverage.find((row) => row.segmentKey === key)?.reason ??
          'Host enumerates this requested segment from actual conclusion links. No link means no accepted conclusion, not evidence of irrelevance or absence of exposure.',
      }))
      .map((row) => ({
        ...row,
        insightIndexes: model.generalInsights.flatMap((i, index) =>
          i.segmentKeys.includes(row.segmentKey) ? [index] : [],
        ),
      })),
  };
}
