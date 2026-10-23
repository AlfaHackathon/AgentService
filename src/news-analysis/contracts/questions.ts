import { z } from 'zod';

export const mechanisms = [
  'financing_cost',
  'refinancing_access',
  'lease_cost',
  'rent_indexation',
  'demand',
  'input_cost',
  'investment',
  'liquidity',
  'tax',
  'supply_capacity',
  'labor_cost',
  'deposit_income',
] as const;
export const periodPattern =
  /^(?:unknown|(?:(?:from|budget|actual|previous):)?\d{4}(?:-(?:Q[1-4]|(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?))?)$/;
export const questionSchema = z
  .strictObject({
    mechanism: z.enum(mechanisms),
    frame: z.enum(['event_only', 'absolute', 'budget_delta']),
    unit: z.string().min(1).max(64),
    targetPeriod: z.string().regex(periodPattern),
    baselinePeriod: z.string().regex(periodPattern).nullable(),
    basis: z
      .enum([
        'qualitative',
        'monthly_run_rate',
        'annual_run_rate',
        'contract_total',
        'actual_cashflow',
        'budget_total',
        'unknown',
      ])
      .nullable()
      .optional(),
  })
  .refine(
    (q) => q.frame !== 'budget_delta' || q.baselinePeriod !== null,
    'Budget delta requires an explicit comparison baseline',
  );
