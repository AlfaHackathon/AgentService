import * as v from 'valibot';
import {
  extractInventories,
  reviewInventories,
  signalExtractionSchema,
  signalReviewSchema,
} from '../source-signals.ts';
import { type AgentTask, useResultTool } from './result.ts';

export function useSourceSignalTools(task: AgentTask) {
  const signalUnits = task.signalUnits;
  if (!signalUnits) throw new Error('Missing source units');
  useResultTool(
    'extract_source_signals',
    signalExtractionSchema(signalUnits.map((u) => u.unitId)),
    undefined,
    (data) => {
      const result = { inventories: extractInventories(data, signalUnits) };
      if (JSON.stringify(result).length > 60000)
        throw new Error(
          'Extraction exceeds 60000 character review reservation. Shorten quotes and explanations without dropping independent signals or units.',
        );
      return result;
    },
  );
  return;
}

export function useSourceSignalReviewTools(task: AgentTask) {
  // Durable conversations created before targeted review retain the original protocol.
  if (!task.signalDraft) return useSourceSignalTools(task);
  if (!task.signalUnits) throw new Error('Missing review source catalog');
  const units = task.signalUnits,
    draft = task.signalDraft;
  useResultTool(
    'review_source_signals',
    signalReviewSchema(units.map((u) => u.unitId)),
    undefined,
    (data) => {
      const result = { inventories: reviewInventories(data, units, draft) };
      if (JSON.stringify(result).length > 60000)
        throw new Error('Reviewed extraction exceeds 60000 character budget');
      return result;
    },
  );
  return;
}

export function useEvidenceRelevanceTools(task: AgentTask) {
  const sources = task.evidenceSources;
  if (!sources) throw new Error('Missing evidence catalog');
  const schema = v.strictObject({
    assessments: v.pipe(
      v.array(
        v.strictObject({
          handle: v.picklist(sources.map((_, i) => `d${i}`)),
          status: v.picklist(['related', 'unrelated', 'unknown']),
          reason: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
          quote: v.pipe(v.string(), v.maxLength(1600)),
        }),
      ),
      v.maxLength(8),
    ),
  });
  useResultTool(
    'assess_evidence_relevance',
    schema,
    undefined,
    (data) => {
      const model = v.parse(schema, data);
      if (
        model.assessments.length !== sources.length ||
        new Set(model.assessments.map((r) => r.handle)).size !== sources.length
      )
        throw new Error('Assess every supplied document exactly once');
      return {
        assessments: model.assessments.map(({ handle, ...row }) => {
          const s = sources[Number(handle.slice(1))];
          if (!s) throw new Error('Unknown document');
          if (row.status !== 'unknown' && (!row.quote || !s.text.includes(row.quote)))
            throw new Error('Quote exact evidence; uncertainty must remain unknown');
          return {
            ...row,
            sourceRef: {
              materialId: s.materialId,
              versionId: s.versionId,
              contentHash: s.contentHash,
            },
          };
        }),
      };
    },
    undefined,
    2,
  );
  return;
}
