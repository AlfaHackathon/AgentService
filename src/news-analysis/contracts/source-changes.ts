import { z } from 'zod';
import { timestampSchema } from './timestamps.ts';
export const sourceChangeSchema = z.object({
  sequence: z.number().int().nonnegative(),
  category: z.string(),
  entityId: z.string(),
  versionId: z.string(),
  knownAt: timestampSchema,
  companyIds: z.array(z.uuid()),
});
export type SourceChange = z.infer<typeof sourceChangeSchema>;
export const sourceCursorSchema = z.object({
  version: z.number().int(),
  sequence: z.number().int().nonnegative(),
  afterQuestion: z.string().nullable(),
});
export const reactionPageSchema = z.object({
  items: z.array(
    z.object({
      effectId: z.string().nullable(),
      kind: z.enum(['question', 'analysis_watch']).optional(),
      analysisId: z.string().nullable().optional(),
      companyId: z.uuid(),
      bankProfileId: z.string().nullable(),
      newsMaterialId: z.string(),
      newsVersionId: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
