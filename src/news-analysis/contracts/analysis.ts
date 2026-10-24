import { z } from 'zod';
import { mechanisms, questionSchema } from './questions.ts';
import { timestampSchema } from './timestamps.ts';

const identifier = z.string().trim().min(1).max(200);
const timestamp = timestampSchema;
const bankProfile = z.string().regex(/^U_\d+$/);
const evidenceId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const maximumDrafts = 32;
export const materialTriggerSchema = z.strictObject({
  materialId: identifier,
  versionId: identifier,
});

export const analysisRequestSchema = z.strictObject({
  companyId: z.uuid().transform((value) => value.toLowerCase()),
  bankProfileId: bankProfile.optional(),
  newsMaterialId: identifier,
  newsVersionId: identifier,
  asOf: timestamp,
  retrievalQueries: z.array(z.string().trim().min(1).max(16000)).min(1).max(6).optional(),
  retrievalLimit: z.number().int().min(1).max(12).optional(),
  trigger: materialTriggerSchema.optional(),
  mechanisms: z.array(z.enum(mechanisms)).min(1).max(12).optional(),
});
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;

export const sourceRefSchema = z.strictObject({
  materialId: identifier,
  versionId: identifier,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const assessmentSchema = z.strictObject({
  applicability: z
    .strictObject({
      status: z.enum(['established', 'unknown', 'excluded']),
      basis: z.enum(['documented_exposure', 'profile_signal', 'market_only', 'not_established']),
      explanation: z.string().min(1).max(2000),
      sourceRefs: z.array(sourceRefSchema).max(16),
      assumptions: z.array(z.string().min(1).max(1000)).max(8),
    })
    .optional(),
  conditions: z
    .array(
      z.strictObject({
        id: evidenceId.optional(),
        assertion: z.enum(['observed', 'derived', 'conditional']).optional(),
        dependsOn: z.array(evidenceId).max(16).optional(),
        fact: z.string().min(1).max(1000),
        predicate: z.string().min(1).max(1000),
        status: z.enum(['supported', 'contradicted', 'unknown']),
        sourceRefs: z.array(sourceRefSchema).max(64),
      }),
    )
    .max(16),
  unknowns: z
    .array(
      z.strictObject({
        id: evidenceId.optional(),
        fact: z.string().min(1).max(1000),
        query: z.string().min(1).max(2000).nullable(),
        scope: z.enum(['company', 'market']),
        materialId: identifier.nullable(),
      }),
    )
    .max(16),
});
const retrievalTraceSchema = z
  .array(
    z.object({
      round: z.number().int(),
      queries: z.array(z.string()),
      retrievedSources: z.array(sourceRefSchema),
      stopReason: z.string(),
    }),
  )
  .max(4);

export type DecimalExpression =
  | { kind: 'value'; value: string }
  | {
      kind: 'add' | 'subtract' | 'multiply' | 'divide' | 'min' | 'max';
      left: DecimalExpression;
      right: DecimalExpression;
    };

const expressionNode: z.ZodType<DecimalExpression> = z.lazy(() =>
  z.union([
    z.strictObject({
      kind: z.literal('value'),
      value: z
        .string()
        .max(100)
        .regex(/^-?(0|[1-9]\d*)(\.\d+)?$/),
    }),
    z.strictObject({
      kind: z.enum(['add', 'subtract', 'multiply', 'divide', 'min', 'max']),
      left: expressionNode,
      right: expressionNode,
    }),
  ]),
);

const expressionSchema = expressionNode.superRefine((expression, context) => {
  const pending = [{ expression, depth: 1 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if (++nodes > 127 || item.depth > 12) {
      context.addIssue({ code: 'custom', message: 'Calculation tree is too large' });
      return;
    }
    if (item.expression.kind !== 'value') {
      pending.push(
        { expression: item.expression.left, depth: item.depth + 1 },
        { expression: item.expression.right, depth: item.depth + 1 },
      );
    }
  }
});

export const calculationSchema = z.strictObject({
  expression: expressionSchema,
  unit: z.string().trim().min(1).max(64),
  period: z.string().trim().min(1).max(1000),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// C# ExpressionNode serialises every nullable record member. Accept its inactive
// null placeholders on service responses, then validate the same strict AST.
// Model drafts and writes continue to use calculationSchema without this adapter.
function normalizeResponseExpression(input: unknown): unknown {
  let nodes = 0;
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 127 || depth > 12) return null;
    if (!isRecord(value)) return value;
    const node = { ...value };
    if (node.kind === 'value') {
      if (node.left === null) delete node.left;
      if (node.right === null) delete node.right;
    } else if (
      node.kind === 'add' ||
      node.kind === 'subtract' ||
      node.kind === 'multiply' ||
      node.kind === 'divide' ||
      node.kind === 'min' ||
      node.kind === 'max'
    ) {
      if (node.value === null) delete node.value;
      node.left = visit(node.left, depth + 1);
      node.right = visit(node.right, depth + 1);
    }
    return node;
  }
  return visit(input, 1);
}

export const responseCalculationSchema = calculationSchema.extend({
  expression: z.preprocess(normalizeResponseExpression, expressionSchema),
});

export const draftSchema = z.strictObject({
  question: questionSchema.optional(),
  assessment: assessmentSchema.optional(),
  effectKey: identifier,
  literalObjectRef: z.string().trim().min(1).max(500),
  conclusion: z.string().trim().min(1).max(12000),
  status: identifier.max(100),
  sourceRefs: z.array(sourceRefSchema).min(1).max(64),
  calculation: calculationSchema.optional(),
  impact: z
    .strictObject({
      metric: identifier,
      amountBasis: identifier,
      economicObjectId: z.string().min(1).max(500).nullable(),
      evidenceStatus: z.enum(['supported', 'conditional', 'unknown', 'contradicted', 'unaffected']),
      importance: z.number().int().min(0).max(5),
      urgency: z.number().int().min(0).max(5),
      novelty: z.number().int().min(0).max(5),
    })
    .optional(),
});
export type EffectDraft = z.infer<typeof draftSchema>;
export const reasoningOutputSchema = z.strictObject({
  drafts: z.array(draftSchema).max(maximumDrafts),
});

export const materialSchema = z.object({
  materialId: identifier,
  versionId: identifier,
  sourceId: identifier,
  kind: z.enum(['news', 'company', 'market']),
  title: z.string(),
  text: z.string(),
  knownAt: timestamp,
  publishedAt: timestamp.nullable().optional(),
  provenance: z
    .object({
      acquisition: z.enum(['uploaded', 'event_payload', 'news_service']),
      sourceUrl: z.url().nullable(),
      retrievedAt: timestamp,
      textCompleteness: z.enum(['full', 'lead', 'excerpt', 'unknown']),
      originVersionId: identifier.nullable(),
      locator: z.string().nullable(),
    })
    .nullable()
    .optional(),
  correctsVersionId: identifier.nullable().optional(),
  companyIds: z.array(z.uuid()),
  bankProfileIds: z.array(bankProfile),
  contentHash: sourceRefSchema.shape.contentHash,
});

export const contextBundleSchema = z.object({
  news: materialSchema,
  materials: z.array(materialSchema),
  coverage: z.object({
    complete: z.boolean(),
    materialCount: z.number().int().nonnegative(),
    companyMaterialCount: z.number().int().nonnegative(),
    marketMaterialCount: z.number().int().nonnegative(),
    previousNewsVersionCount: z.number().int().nonnegative(),
    characters: z.number().int().nonnegative(),
    asOf: timestamp,
    budget: z
      .object({
        maximumCharacters: z.number().int().positive(),
        usedCharacters: z.number().int().nonnegative(),
        omittedSources: z.array(sourceRefSchema),
        stopReason: z.enum(['within_budget', 'context_budget']),
      })
      .nullable()
      .optional(),
  }),
  retrieval: z
    .object({
      mode: z.string(),
      reranker: z.string(),
      candidateCount: z.number().int(),
      selectedMaterials: z.number().int(),
      availableMaterials: z.number().int(),
      omittedMaterials: z.number().int(),
      exhaustive: z.boolean(),
    })
    .optional(),
});
export type ContextBundle = z.infer<typeof contextBundleSchema>;

const revisionSchema = z.object({
  publicationClass: z
    .enum(['consequence', 'scenario', 'missing_data', 'unaffected', 'review'])
    .nullable()
    .optional(),
  modelExplanation: z.string().nullable().optional(),
  trigger: materialTriggerSchema.nullable().optional(),
  assessment: assessmentSchema.nullable().optional(),
  // Historical receipts stay readable after stricter identity validation is added.
  // Only current valid identities can be selected by the native question tool.
  question: questionSchema
    .safeExtend({ targetPeriod: z.string(), baselinePeriod: z.string().nullable() })
    .nullable()
    .optional(),
  newsMaterialId: identifier.nullable().optional(),
  revisionId: identifier,
  previousRevisionId: identifier.nullable(),
  newsVersionId: identifier,
  asOf: timestamp,
  conclusion: z.string(),
  status: identifier,
  sourceRefs: z.array(sourceRefSchema),
  calculation: responseCalculationSchema.nullable().optional(),
  calculationResult: z.string().nullable().optional(),
  calculationArithmeticOnly: z.boolean().nullable().optional(),
  createdAt: timestamp,
  impact: draftSchema.shape.impact.nullable(),
});

export const effectsResponseSchema = z.object({
  effects: z.array(
    z.object({
      effectId: identifier,
      requiresReassessment: z.boolean().optional(),
      effectKey: identifier,
      companyId: z.uuid(),
      bankProfileId: bankProfile.nullable().optional(),
      newsMaterialId: identifier,
      literalObjectRef: z.string(),
      currentRevision: revisionSchema,
      history: z.array(revisionSchema),
    }),
  ),
});
export type StoredEffect = z.infer<typeof effectsResponseSchema>['effects'][number];

export const analysisReceiptSchema = z.object({
  trigger: materialTriggerSchema.nullable().optional(),
  retrievalTrace: retrievalTraceSchema.nullable().optional(),
  analysisId: identifier,
  duplicate: z.boolean(),
  resultSemantics: z.literal('saved_analysis_revisions_not_latest_heads'),
  companyId: z.uuid(),
  bankProfileId: bankProfile.nullable().optional(),
  newsMaterialId: identifier,
  newsVersionId: identifier,
  asOf: timestamp,
  completedAt: timestamp,
  contextComplete: z.boolean().nullable().optional(),
  unrevisedEffectIds: z.array(identifier).nullable().optional(),
  effects: z.array(
    z.object({
      effectId: identifier,
      revisionId: identifier,
      previousRevisionId: identifier.nullable(),
      duplicate: z.boolean(),
      currentRevision: revisionSchema,
    }),
  ),
});
export type AnalysisReceipt = z.infer<typeof analysisReceiptSchema>;
export const analysisWriteSchema = analysisRequestSchema.extend({
  expectedStateVersion: z.number().int().nonnegative().optional(),
  retrievalTrace: retrievalTraceSchema.optional(),
  contextComplete: z.boolean().optional(),
  drafts: z
    .array(draftSchema.extend({ expectedPreviousRevisionId: identifier.nullable() }))
    .max(maximumDrafts),
});
export type AnalysisWrite = z.infer<typeof analysisWriteSchema>;

export type ReasoningInput = {
  request: AnalysisRequest;
  context: ContextBundle;
  previousEffects: StoredEffect[];
  toolTrace?: z.infer<typeof retrievalTraceSchema>;
};
export interface NewsReasoner {
  retrievalMode?: 'agent_tools';
  analyze(input: ReasoningInput): Promise<EffectDraft[]>;
  review?(
    input: ReasoningInput,
    drafts: EffectDraft[],
    arithmeticFeedback: unknown,
  ): Promise<EffectDraft[]>;
}
