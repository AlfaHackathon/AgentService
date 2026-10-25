import { z } from 'zod';
import {
  analysisReceiptSchema,
  companyImportanceSchema,
  draftSchema,
  responseCalculationSchema,
  sourceRefSchema,
} from '../news-analysis/contracts/analysis.ts';
import { insightCategorySchema } from '../news-analysis/contracts/category.ts';
import { newsPlanSchema } from '../news-analysis/contracts/flow.ts';
import { mechanisms } from '../news-analysis/contracts/questions.ts';
import { timestampSchema } from '../news-analysis/contracts/timestamps.ts';

const id = z.string().min(1).max(512);
export const insightKindSchema = z.enum(['personal', 'general']);
export const feedQuerySchema = z
  .strictObject({
    kind: insightKindSchema.default('personal'),
    category: insightCategorySchema.optional(),
    limit: z.coerce.number().int().min(1).max(20).default(5),
    cursor: z.string().max(2048).optional(),
    status: z.string().min(1).max(100).optional(),
    mechanism: z.enum(mechanisms).optional(),
    newsMaterialId: z.string().min(1).max(200).optional(),
    minImportance: z.coerce.number().int().min(1).max(5).optional(),
  })
  .refine(
    (q) =>
      q.kind === 'personal' ||
      (q.status === undefined && q.mechanism === undefined && q.minImportance === undefined),
    'Status, mechanism and importance filters apply to personal insights only.',
  );
export const historyQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(20).default(10),
  cursor: z.string().max(2048).optional(),
});
export const insightIdSchema = id;
// Preserve historical cards even when a legacy calculation has an unknown unit.
// The calculation remains internal; indicator projection validates its dimensions.
export const storedRevisionSchema =
  analysisReceiptSchema.shape.effects.element.shape.currentRevision.extend({
    calculation: responseCalculationSchema.extend({ unit: z.string() }).nullable().optional(),
  });
export const personalReadSchema = z.object({
  id,
  companyId: z.uuid(),
  newsMaterialId: z.string().min(1).max(200),
  literalObjectRef: z.string().max(500),
  currentRevision: storedRevisionSchema,
  requiresReassessment: z.boolean(),
});
export const generalReadSchema = z.object({
  id,
  companyId: z.uuid(),
  jobId: z.string().min(1).max(200),
  insightIndex: z.number().int().min(0).max(23),
  newsMaterialId: z.string().min(1).max(200),
  newsVersionId: z.string().min(1).max(200),
  asOf: timestampSchema,
  updatedAt: timestampSchema,
  textCompleteness: z.enum(['full', 'lead', 'unknown']),
  companyStatus: z.enum(['completed', 'failed', 'pending']),
  insight: newsPlanSchema.shape.generalInsights.element,
});
export const readPage = <T extends z.ZodType>(item: T) =>
  z.object({
    companyId: z.uuid(),
    items: z.array(item).max(20),
    nextCursor: z.string().max(2048).nullable(),
  });
export const sourceMetadataSchema = z.object({
  ...sourceRefSchema.shape,
  sourceId: z.string(),
  kind: z.enum(['news', 'company', 'market']),
  title: z.string(),
  knownAt: timestampSchema,
  publishedAt: timestampSchema.nullable(),
  provenance: z
    .object({
      acquisition: z.string(),
      sourceUrl: z.url().nullable(),
      retrievedAt: timestampSchema,
      textCompleteness: z.enum(['full', 'lead', 'excerpt', 'unknown']),
      originVersionId: z.string().nullable(),
    })
    .nullable(),
});
const publicImpact = draftSchema.shape.impact
  .unwrap()
  .pick({ metric: true, amountBasis: true, economicObjectId: true, evidenceStatus: true });
// Explicit public allowlist: future internal revision fields do not become public automatically.
export const publicRevisionSchema = storedRevisionSchema
  .pick({
    publicationClass: true,
    trigger: true,
    assessment: true,
    question: true,
    newsMaterialId: true,
    revisionId: true,
    previousRevisionId: true,
    newsVersionId: true,
    asOf: true,
    conclusion: true,
    status: true,
    sourceRefs: true,
    createdAt: true,
  })
  .extend({
    category: insightCategorySchema.nullable(),
    companyImportance: companyImportanceSchema.nullable(),
    impact: publicImpact.nullable(),
  });
export const indicatorSchema = z
  .object({
    name: z.string(),
    metric: z.string(),
    value: z.string(),
    unit: z.string(),
    period: z.string(),
    baselinePeriod: z.string().nullable(),
    evidenceStatus: z.enum(['supported', 'conditional']),
    sourceRefs: z.array(sourceRefSchema),
    arithmeticOnly: z.boolean().nullable(),
  })
  .meta({
    examples: [
      {
        name: 'Изменение расходов',
        metric: 'expense_delta',
        value: '15600',
        unit: 'RUB',
        period: '2026-11',
        baselinePeriod: null,
        evidenceStatus: 'conditional',
        sourceRefs: [{ materialId: 'synthetic-own', versionId: 'v1', contentHash: 'a'.repeat(64) }],
        arithmeticOnly: true,
      },
    ],
  });
export const indicatorAvailabilitySchema = z.object({
  reason: z.enum([
    'available',
    'no_calculation',
    'missing_result',
    'stale_sources',
    'insufficient_evidence',
    'unknown_period',
    'unknown_baseline',
    'general_not_company_calculation',
  ]),
  explanation: z.string(),
});
const indicatorFields = {
  indicators: z.array(indicatorSchema).max(1),
  indicatorAvailability: indicatorAvailabilitySchema,
};
export const personalCardSchema = z.object({
  kind: z.literal('personal'),
  id,
  companyId: z.uuid(),
  newsMaterialId: z.string(),
  literalObjectRef: z.string(),
  currentRevision: publicRevisionSchema,
  requiresReassessment: z.boolean(),
  sources: z.array(sourceMetadataSchema).max(64),
  ...indicatorFields,
});
export const publicGeneralInsightSchema = newsPlanSchema.shape.generalInsights.element
  .pick({
    signalIds: true,
    quality: true,
    title: true,
    conclusion: true,
    mechanism: true,
    applicability: true,
    exclusions: true,
    unknowns: true,
    sourceRefs: true,
  })
  .extend({ category: insightCategorySchema.nullable() });
export const generalCardSchema = z.object({
  kind: z.literal('general'),
  id,
  companyId: z.uuid(),
  newsMaterialId: z.string(),
  newsVersionId: z.string(),
  asOf: timestampSchema,
  updatedAt: timestampSchema,
  textCompleteness: z.enum(['full', 'lead', 'unknown']),
  companyStatus: z.enum(['completed', 'failed', 'pending']),
  requiresReassessment: z
    .null()
    .describe(
      'General job snapshots do not have a current invalidation assessment; null means unknown, not fresh.',
    ),
  insight: publicGeneralInsightSchema,
  sources: z.array(sourceMetadataSchema).max(32),
  ...indicatorFields,
});
export const publicCardSchema = z.discriminatedUnion('kind', [
  personalCardSchema,
  generalCardSchema,
]);
export const publicFeedSchema = z.object({
  companyId: z.uuid(),
  items: z.array(publicCardSchema).max(20),
  nextCursor: z.string().nullable(),
  exhaustive: z.literal(false),
});
export const publicHistorySchema = z.object({
  companyId: z.uuid(),
  insightId: id,
  items: z
    .array(
      z.object({
        revision: publicRevisionSchema,
        sources: z.array(sourceMetadataSchema).max(64),
        ...indicatorFields,
      }),
    )
    .max(20),
  nextCursor: z.string().nullable(),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;
export type StoredRevision = z.infer<typeof storedRevisionSchema>;
