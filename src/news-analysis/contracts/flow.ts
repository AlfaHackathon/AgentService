import { z } from 'zod';
import {
  analysisReceiptSchema,
  type materialSchema,
  materialTriggerSchema,
  sourceRefSchema,
} from './analysis.ts';
import { depthDecisionSchema } from './depth.ts';
import { mechanisms } from './questions.ts';
import { type SignalInventory, signalCoverageSchema, signalInventorySchema } from './signals.ts';
import { timestampSchema } from './timestamps.ts';

export const flowRequestSchema = z.strictObject({
  newsMaterialId: z.string().trim().min(1).max(200),
  newsVersionId: z.string().trim().min(1).max(200),
  asOf: timestampSchema,
  groupIds: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  personIds: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
  companyBudget: z.number().int().min(1).max(64).default(12),
  retrievalLimit: z.number().int().min(1).max(12).optional(),
  textCompleteness: z.enum(['full', 'lead', 'unknown']).default('unknown'),
  trigger: materialTriggerSchema.optional(),
  targetCompanyIds: z.array(z.uuid()).max(256).default([]),
  projectionOnly: z.boolean().default(false),
});
export type FlowRequest = z.infer<typeof flowRequestSchema>;
export const declaredProfileSchema = z.object({
  region: z.string().max(128).nullable(),
  industrySections: z
    .array(z.string().regex(/^[A-U]$/))
    .max(21)
    .nullable(),
  revenue: z
    .object({
      amount: z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/),
      currency: z.string().nullable(),
      period: z.string().nullable(),
    })
    .nullable(),
  countOfEmployees: z.number().int().nonnegative().nullable(),
  sourceRefs: z.array(sourceRefSchema).length(1),
});
export const companyProfileSchema = z.object({
  declaredProfile: declaredProfileSchema.nullable().optional(),
  companyId: z.uuid(),
  revisionId: z.string(),
  bankProfileId: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  industryCodes: z.array(z.string()),
  exposures: z.array(z.string()),
  knownAt: timestampSchema,
  sourceRefs: z.array(sourceRefSchema),
});
export const roleProfileSchema = z.object({
  personId: z.string(),
  companyId: z.uuid(),
  revisionId: z.string(),
  role: z.string(),
  responsibilities: z.array(z.string()),
  allowedCompanyIds: z.array(z.uuid()),
  allowedMaterialIds: z.array(z.string()),
  knownAt: timestampSchema,
  sourceRefs: z.array(sourceRefSchema),
});
export type RoleProfile = z.infer<typeof roleProfileSchema>;
export const groupExpansionSchema = z.object({
  groupId: z.string(),
  companyIds: z.array(z.uuid()),
  paths: z.array(z.object({ companyId: z.uuid(), groupIds: z.array(z.string()) })),
  missingGroups: z.array(z.string()),
  cycles: z.array(z.array(z.string())),
  complete: z.boolean(),
  aggregationRule: z.literal('sum_compatible_owner_effects').nullable().optional(),
  sourceRefs: z.array(sourceRefSchema),
});
export type GroupExpansion = z.infer<typeof groupExpansionSchema>;
export const sourceCoverageSchema = z
  .array(
    z.strictObject({
      unitId: z.string().min(1).max(200),
      disposition: z.enum(['used', 'background', 'not_applicable', 'unreadable']),
      signals: z.array(z.string().min(1).max(600)).max(12).default([]),
      insightIndexes: z.array(z.number().int().min(0).max(23)).max(24),
      reason: z.string().min(1).max(1500),
    }),
  )
  .max(64);
export const newsPlanSchema = z.strictObject({
  mechanisms: z.array(z.enum(mechanisms)).min(1).max(12).optional(),
  sourceCoverage: sourceCoverageSchema.optional(),
  signalCoverage: signalCoverageSchema.optional(),
  segmentCoverage: z
    .array(
      z.strictObject({
        segmentKey: z.string().min(1).max(200),
        insightIndexes: z.array(z.number().int().min(0).max(7)).max(8),
        reason: z.string().min(1).max(2000),
      }),
    )
    .max(8)
    .optional(),
  eventSummary: z.string().min(1).max(4000),
  queries: z.array(z.string().min(1).max(2000)).min(1).max(6),
  generalInsights: z
    .array(
      z.strictObject({
        signalIds: z.array(z.string()).max(128).optional(),
        quality: z
          .object({
            decisionQuestion: z.string().min(1).max(700),
            distinctContribution: z.string().min(1).max(700),
            priority: z.enum(['high', 'medium', 'low']),
            novelty: z.enum(['news_specific', 'source_context']),
          })
          .optional(),
        title: z.string().min(1).max(500),
        conclusion: z.string().min(1).max(6000),
        mechanism: z.string().min(1).max(4000),
        applicability: z.array(z.string().max(1000)).max(16),
        exclusions: z.array(z.string().max(1000)).max(16),
        unknowns: z.array(z.string().max(1000)).max(16),
        sourceRefs: z.array(sourceRefSchema).min(1).max(32),
      }),
    )
    .max(8),
});
export const segmentPlanSchema = newsPlanSchema.extend({
  queries: z.array(z.string().min(1).max(2000)).max(6),
  sourceCoverage: sourceCoverageSchema,
  generalInsights: z.array(newsPlanSchema.shape.generalInsights.element).max(24),
  segmentCoverage: z
    .array(
      z.strictObject({
        segmentKey: z.string().min(1).max(200),
        insightIndexes: z.array(z.number().int().min(0).max(23)).max(24),
        reason: z.string().min(1).max(2000),
      }),
    )
    .max(8),
});
export type NewsPlan = z.infer<typeof newsPlanSchema>;
export const roleActionsSchema = z.strictObject({
  actions: z
    .array(
      z.strictObject({
        action: z.string().min(1).max(2000),
        rationale: z.string().min(1).max(2000),
        effectIds: z.array(z.string().min(1)).min(1).max(32),
        priority: z.number().int().min(0).max(5),
      }),
    )
    .max(12),
  missingContext: z.array(z.string().min(1).max(1000)).max(16),
});
export type RoleActions = z.infer<typeof roleActionsSchema>;
export type RoleFact = {
  companyId: string;
  effectId: string;
  revision: import('./analysis.ts').AnalysisReceipt['effects'][number]['currentRevision'];
};
export type RoleGroup = {
  groupId: string;
  companyIds: string[];
  complete: boolean;
  coverage: {
    expectedCompanies: number;
    analyzedCompanies: number;
    missingCompanyIds: string[];
    missingGroups: string[];
    cycles: string[][];
    unknownEffects: string[];
    duplicateObjects: string[];
    unrevisedEffectIds: string[];
    emptyCompanyIds: string[];
    partialContextCompanyIds: string[];
    aggregationRuleConfirmed: boolean;
  };
  totals: {
    metric: string;
    amountBasis: string;
    unit: string;
    period: string;
    question: NonNullable<RoleFact['revision']['question']> | null;
    knownSubtotal: string;
    fullTotal: string | null;
    coverage: {
      complete: boolean;
      missingCompanyIds: string[];
      unresolvedEffectIds: string[];
      duplicateObjects: string[];
    };
    effectIds: string[];
    companyIds: string[];
  }[];
  sourceRefs: GroupExpansion['sourceRefs'];
};
export interface FlowReasoner {
  relevance?(
    news: z.infer<typeof materialSchema>,
    plan: NewsPlan,
    sources: z.infer<typeof materialSchema>[],
  ): Promise<import('./relevance.ts').Relevance>;
  signals?(sources: z.infer<typeof materialSchema>[]): Promise<SignalInventory[]>;
  segments?(
    news: z.infer<typeof materialSchema>,
    sources: z.infer<typeof materialSchema>[],
    segments: Segment[],
    asOf: string,
    inventories?: SignalInventory[],
  ): Promise<NewsPlan>;
  plan(
    news: z.infer<typeof materialSchema>,
    publicSources: z.infer<typeof materialSchema>[],
    textCompleteness: FlowRequest['textCompleteness'],
    scope?: { asOf: string },
  ): Promise<NewsPlan>;
  role(
    profile: Pick<RoleProfile, 'personId' | 'companyId' | 'role' | 'responsibilities'>,
    facts: RoleFact[],
    groups?: RoleGroup[],
    scope?: { asOf: string },
  ): Promise<RoleActions>;
}
export const companyRunSchema = z.object({
  segmentKeys: z.array(z.string()).optional(),
  depth: depthDecisionSchema.optional(),
  companyId: z.uuid(),
  status: z.enum(['completed', 'failed']),
  receipt: analysisReceiptSchema.optional(),
  error: z.string().optional(),
  contextComplete: z.boolean().optional(),
  staleEffectIds: z.array(z.string()).optional(),
});
export type CompanyRun = z.infer<typeof companyRunSchema>;
export const jobSchema = z.object({
  request: z.object({
    jobId: z.string(),
    newsMaterialId: z.string(),
    newsVersionId: z.string(),
    asOf: timestampSchema,
    parameters: z.unknown(),
  }),
  status: z.enum(['queued', 'running', 'partial', 'completed', 'failed']),
  version: z.number().int(),
  workerId: z.string().nullable(),
  leaseUntil: timestampSchema.nullable(),
  checkpoint: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  updatedAt: timestampSchema,
});
export type NewsJob = z.infer<typeof jobSchema>;
export const segmentSchema = z.object({
  key: z.string(),
  labels: z.array(z.string()),
  companyIds: z.array(z.uuid()),
  profileRefs: z.array(sourceRefSchema),
});
export type Segment = z.infer<typeof segmentSchema>;
export const segmentBatchSchema = z.object({
  coverageVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  segments: z.array(segmentSchema),
  plan: z.union([segmentPlanSchema, newsPlanSchema]),
  sources: z.array(sourceRefSchema),
  omittedSources: z.number().int().nonnegative(),
  retrievalExhaustive: z.boolean(),
});
export const checkpointSchema = z.object({
  signalInventories: z.array(signalInventorySchema).default([]),
  segmentBatches: z.array(segmentBatchSchema).default([]),
  plan: newsPlanSchema.optional(),
  selectedCompanyIds: z.array(z.uuid()).optional(),
  pendingCompanyIds: z.array(z.uuid()).optional(),
  recipientCursor: z.string().nullable().optional(),
  groups: z.array(groupExpansionSchema).optional(),
  companies: z.array(companyRunSchema).default([]),
  watchCursors: z
    .array(
      z.object({
        companyId: z.uuid(),
        afterSequence: z.number().int().nonnegative(),
        complete: z.boolean(),
        followupJobIds: z.array(z.string()),
      }),
    )
    .max(256)
    .default([]),
  canonicalCompanies: z.array(companyRunSchema).optional(),
  roleViews: z.array(z.unknown()).default([]),
  result: z.unknown().optional(),
});
export type FlowCheckpoint = z.infer<typeof checkpointSchema>;
