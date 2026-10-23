import { z } from 'zod';
import { sourceRefSchema } from './analysis.ts';
import { mechanisms } from './questions.ts';

const signalFields = {
  kind: z.enum(['observation', 'forecast', 'hypothesis', 'unknown']),
  statement: z.string().min(1).max(800),
  quote: z.string().min(1).max(1800),
  period: z.string().min(1).max(200),
  scope: z.string().min(1).max(400),
  mechanisms: z.array(z.enum(mechanisms)).min(1).max(12),
};
export const sourceSignalSchema = z.object({
  signalId: z.string(),
  unitId: z.string(),
  sourceRef: sourceRefSchema,
  tableHeader: z.string().optional(),
  ...signalFields,
});
export type SourceSignal = z.infer<typeof sourceSignalSchema>;
export const signalInventorySchema = z.object({
  version: z.literal(1),
  sourceRef: sourceRefSchema,
  units: z.array(
    z.object({
      unitId: z.string(),
      reason: z.string(),
      disposition: z.enum(['signals', 'background', 'unreadable']),
    }),
  ),
  signals: z.array(sourceSignalSchema).max(128),
});
export type SignalInventory = z.infer<typeof signalInventorySchema>;
export const signalCoverageSchema = z
  .array(
    z.object({
      signalId: z.string(),
      disposition: z.enum(['used', 'merged', 'background', 'not_applicable', 'unreadable']),
      insightIndexes: z.array(z.number().int().min(0).max(23)).max(24),
      reason: z.string().min(1).max(700),
    }),
  )
  .max(128);
