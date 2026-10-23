import type { z } from 'zod';
import type { StoredEffect } from '../contracts/analysis.ts';
import type { DepthDecision, evidenceInventorySchema } from '../contracts/depth.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import type { FlowRequest, NewsPlan } from '../contracts/flow.ts';
import type { Relevance } from '../contracts/relevance.ts';
import { instantAfter, sameInstant } from '../contracts/timestamps.ts';
import { sourceKey } from '../retrieval/source-catalog.ts';
import { relevantEffects } from './evidence-relevance.ts';
export function chooseDepth(input: {
  companyId: string;
  request: FlowRequest;
  plan: NewsPlan;
  inventory: z.infer<typeof evidenceInventorySchema>;
  previous: StoredEffect[];
  hasProfile: boolean;
  newsCorrection: boolean;
  relevance?: Relevance;
}): DepthDecision {
  const { inventory, request } = input;
  if (
    inventory.companyId.toLowerCase() !== input.companyId.toLowerCase() ||
    !sameInstant(inventory.asOf, request.asOf) ||
    inventory.sources.some((s) => instantAfter(s.knownAt, request.asOf))
  )
    throw new NewsAnalysisError(
      502,
      'DEPTH_SCOPE',
      'Evidence inventory must match company and knowledge time',
    );
  const own = inventory.sources.filter((s) => s.sourceId !== 'provided-bank-csv');
  const irrelevant =
    own.length > 0 &&
    input.relevance?.length === own.length &&
    own.every((s) =>
      input.relevance?.some(
        (r) => sourceKey(r.sourceRef) === sourceKey(s) && r.status === 'unrelated',
      ),
    );
  const reason = request.projectionOnly
    ? 'projection_refresh'
    : request.trigger
      ? 'source_revision'
      : input.newsCorrection
        ? 'news_correction'
        : relevantEffects(input.previous, input.plan.mechanisms).length
          ? 'prior_canonical_state'
          : !inventory.completeForLoadedScope
            ? 'incomplete_inventory'
            : own.length
              ? irrelevant
                ? 'unrelated_evidence'
                : 'own_originals'
              : input.hasProfile || inventory.sources.length
                ? 'profile_only'
                : 'no_own_evidence';
  const level =
    reason === 'projection_refresh'
      ? 'canonical_projection'
      : reason === 'profile_only' || reason === 'unrelated_evidence'
        ? 'applicability'
        : reason === 'no_own_evidence'
          ? 'general'
          : 'company_deep';
  return {
    policyVersion: 'evidence-depth-v1',
    level,
    reason,
    ...(input.relevance ? { relevance: input.relevance } : {}),
    ownOriginalCount: own.length,
    inventoryCompleteForLoadedScope: inventory.completeForLoadedScope,
    sourceRefs: inventory.sources.map(({ materialId, versionId, contentHash }) => ({
      materialId,
      versionId,
      contentHash,
    })),
    // These are links to hypotheses, not assertions of their applicability.
    generalInsightIndexes: input.plan.generalInsights.map((_, i) => i),
    applicability: 'unknown',
    missingFacts:
      level === 'general' || level === 'applicability'
        ? [
            'В загруженном корпусе не установлены собственные договорные, имущественные или операционные основания применимости. Это не доказывает отсутствия обязательств.',
          ]
        : [],
  };
}
