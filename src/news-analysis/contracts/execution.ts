import { z } from 'zod';
import {
  analysisReceiptSchema,
  analysisRequestSchema,
  materialSchema,
  sourceRefSchema,
} from './analysis.ts';
import { depthDecisionSchema } from './depth.ts';
import { companyRunSchema, flowRequestSchema, newsPlanSchema } from './flow.ts';

const revisionSchema = analysisReceiptSchema.shape.effects.element.shape.currentRevision;
const factSchema = z.object({
  companyId: z.uuid(),
  effectId: z.string(),
  revision: revisionSchema,
  priority: z.number(),
  requiresReassessment: z.boolean(),
});
const groupSchema = z.object({
  groupId: z.string(),
  companyIds: z.array(z.uuid()),
  complete: z.boolean(),
  coverage: z.object({
    expectedCompanies: z.number(),
    analyzedCompanies: z.number(),
    missingCompanyIds: z.array(z.uuid()),
    missingGroups: z.array(z.string()),
    cycles: z.array(z.array(z.string())),
    unknownEffects: z.array(z.string()),
    duplicateObjects: z.array(z.string()),
    unrevisedEffectIds: z.array(z.string()),
    emptyCompanyIds: z.array(z.uuid()),
    partialContextCompanyIds: z.array(z.uuid()),
    unassessedCompanyIds: z.array(z.uuid()).optional(),
    aggregationRuleConfirmed: z.boolean(),
  }),
  totals: z.array(
    z.object({
      metric: z.string(),
      amountBasis: z.string(),
      unit: z.string(),
      period: z.string(),
      question: revisionSchema.shape.question.unwrap().unwrap().nullable(),
      knownSubtotal: z.string(),
      fullTotal: z.string().nullable(),
      coverage: z.object({
        complete: z.boolean(),
        missingCompanyIds: z.array(z.uuid()),
        unresolvedEffectIds: z.array(z.string()),
        duplicateObjects: z.array(z.string()),
      }),
      effectIds: z.array(z.string()),
      companyIds: z.array(z.uuid()),
    }),
  ),
  sourceRefs: z.array(sourceRefSchema),
});
const canonicalRunSchema = companyRunSchema.extend({
  receipt: analysisReceiptSchema
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  error: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  contextComplete: z
    .boolean()
    .nullable()
    .optional()
    .transform((value) => value ?? false),
  staleEffectIds: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((value) => value ?? []),
});

export const companyPlanSchema = z.object({
  analysisInput: analysisRequestSchema,
  relevancePlan: newsPlanSchema,
  depth: depthDecisionSchema,
  requiresWatchRegistration: z.boolean(),
  watchAfterSequence: z.number().int().nonnegative(),
  relevanceSources: z.array(materialSchema),
  receipt: analysisReceiptSchema.nullable().optional(),
  segmentKeys: z.array(z.string()),
});
const roleScopeSchema = z.object({
  key: z.string(),
  scopeVersion: z.string().min(1),
  profile: z.object({
    personId: z.string(),
    companyId: z.uuid(),
    role: z.string(),
    responsibilities: z.array(z.string()),
  }),
  facts: z.array(factSchema),
  groups: z.array(groupSchema),
});
export const jobProjectionSchema = z.object({
  canonicalCompanies: z.array(canonicalRunSchema),
  roleScopes: z.array(roleScopeSchema),
  roleViews: z.array(z.unknown()),
  result: z.unknown(),
});
export const sourceJobsSchema = z.object({
  requests: z.array(flowRequestSchema),
  nextCursor: z.string().nullable(),
});
export const companyWatchSchema = z.object({
  requests: z.array(flowRequestSchema),
  afterSequence: z.number().int().nonnegative(),
  complete: z.boolean(),
});
