import { z } from 'zod';
import { sourceRefSchema } from './analysis.ts';
import { relevanceSchema } from './relevance.ts';
export const depthDecisionSchema = z.object({
  policyVersion: z.literal('evidence-depth-v1'),
  level: z.enum(['general', 'applicability', 'company_deep', 'canonical_projection']),
  reason: z.enum([
    'profile_only',
    'unrelated_evidence',
    'no_own_evidence',
    'own_originals',
    'prior_canonical_state',
    'source_revision',
    'news_correction',
    'projection_refresh',
    'incomplete_inventory',
  ]),
  relevance: relevanceSchema.optional(),
  ownOriginalCount: z.number().int().nonnegative(),
  inventoryCompleteForLoadedScope: z.boolean(),
  sourceRefs: z.array(sourceRefSchema).max(128),
  generalInsightIndexes: z.array(z.number().int().min(0).max(7)).max(8),
  applicability: z.literal('unknown'),
  missingFacts: z.array(z.string()).max(8),
});
export type DepthDecision = z.infer<typeof depthDecisionSchema>;
