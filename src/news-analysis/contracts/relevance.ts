import { z } from 'zod';
import { sourceRefSchema } from './analysis.ts';
export const relevanceSchema = z
  .array(
    z.object({
      sourceRef: sourceRefSchema,
      status: z.enum(['related', 'unrelated', 'unknown']),
      reason: z.string().min(1).max(1000),
      quote: z.string().max(1600),
    }),
  )
  .max(8);
export type Relevance = z.infer<typeof relevanceSchema>;
