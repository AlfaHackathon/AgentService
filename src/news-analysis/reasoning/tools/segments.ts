import { useInstruction, usePersistentState } from '@flue/runtime';
import * as v from 'valibot';
import { segmentPlanSchema } from '../../contracts/flow.ts';
import { validateSegmentPlanRefs } from '../../retrieval/plan-coverage.ts';
import { sourceKey } from '../../retrieval/source-catalog.ts';
import { segmentResultSchema } from '../agent-schemas.ts';
import {
  compactSignalPlan,
  normalizeSignalPlan,
  patchSignalCoverage,
  signalPlanSchema,
} from '../signal-plan.ts';
import { type AgentTask, useResultTool } from './result.ts';

export function useSegmentTools(task: AgentTask) {
  const c = task.segmentCatalog;
  if (!c) throw new Error('Missing host segment catalog');
  const inventories = c.inventories;
  if (inventories) {
    const schema = signalPlanSchema(
      inventories.flatMap((i) => i.signals.map((s) => s.signalId)),
      c.segmentKeys,
    );
    const [savedDraft, saveDraft] = usePersistentState<Record<string, unknown> | null>(
      'signal-plan-draft',
      null,
    );
    let draft = savedDraft;
    useInstruction(
      'First submit {plan: completePlan, coveragePatch: null}; a patch is unavailable until a full draft exists. If coverage validation reports missing signals, submit {plan: null, coveragePatch: missingRows}. Host preserves the last full draft. Exactly one of plan and coveragePatch must be non-null. A patch never counts an unlinked signal as used. queries defaults to [] and segmentCoverage is optional: host derives all requested segments from the segmentKeys inside conclusions. Keep quality inside each individual insight.',
    );
    useResultTool(
      'plan_news_insights',
      v.strictObject({
        plan: draft ? v.nullable(schema) : schema,
        coveragePatch: draft ? v.nullable(schema.entries.signalCoverage) : v.null(),
      }),
      (data) => {
        if (
          JSON.stringify(compactSignalPlan(segmentPlanSchema.parse(data))).length > c.maxResultChars
        )
          throw new Error(
            'Condense the result to fit the reserved review budget without removing signal coverage',
          );
        validateSegmentPlanRefs(
          segmentPlanSchema.parse(data),
          c.segmentKeys,
          c.news,
          c.sources,
          c.units,
        );
      },
      (data) => {
        if ((data.plan === null) === (data.coveragePatch === null))
          throw new Error('Provide exactly one non-null plan or coveragePatch');
        draft =
          data.coveragePatch !== null
            ? patchSignalCoverage(draft, v.parse(schema.entries.signalCoverage, data.coveragePatch))
            : v.parse(schema, data.plan);
        saveDraft(draft);
        return normalizeSignalPlan(draft, inventories, c.segmentKeys, c.news);
      },
      6,
    );
    return;
  }
  const schema = segmentResultSchema(
    c.units.map((u) => u.unitId),
    c.segmentKeys,
  );
  const units = new Map(c.units.map((u) => [u.unitId, u]));
  useResultTool(
    'plan_news_insights',
    schema,
    (data) => {
      if (JSON.stringify(data).length > c.maxResultChars)
        throw new Error(
          `Segment result exceeds reserved review budget of ${c.maxResultChars} characters. Condense explanations and deduplicate conclusions; preserve every sourceCoverage row and supported mechanism. Submit the compact result again.`,
        );
      validateSegmentPlanRefs(
        segmentPlanSchema.parse(data),
        c.segmentKeys,
        c.news,
        c.sources,
        c.units,
      );
    },
    (data) => {
      const model = v.parse(schema, data);
      return {
        ...model,
        generalInsights: model.generalInsights.map(
          ({ sourceUnitIds, segmentKeys: _keys, ...insight }) => ({
            ...insight,
            sourceRefs: [
              ...new Map(
                [
                  c.news,
                  ...sourceUnitIds.map((id) => {
                    const unit = units.get(id);
                    if (!unit) throw new Error('Unavailable source unit');
                    return unit.sourceRef;
                  }),
                ].map((ref) => [sourceKey(ref), ref]),
              ).values(),
            ],
          }),
        ),
        sourceCoverage: model.sourceCoverage.map((row) => {
          const insightIndexes = model.generalInsights.flatMap((i, index) =>
            i.sourceUnitIds.includes(row.unitId) ? [index] : [],
          );
          return {
            ...row,
            disposition: insightIndexes.length
              ? 'used'
              : row.disposition === 'used'
                ? 'background'
                : row.disposition,
            reason:
              !insightIndexes.length && row.disposition === 'used'
                ? `No linked insight; source signals retained. ${row.reason}`.slice(0, 1500)
                : row.reason,
            insightIndexes,
          };
        }),
        segmentCoverage: model.segmentCoverage.map((row) => ({
          ...row,
          insightIndexes: model.generalInsights.flatMap((i, index) =>
            i.segmentKeys.includes(row.segmentKey) ? [index] : [],
          ),
        })),
      };
    },
  );
  return;
}
