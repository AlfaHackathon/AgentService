import { z } from 'zod';
import { sameInstant, timestampSchema } from './timestamps.ts';

export const ownerUuidSchema = z
  .uuid()
  .refine((value) => value !== '00000000-0000-0000-0000-000000000000');
const hash = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/u);
const noControls = (value: string) => !/\p{Cc}/u.test(value);
export const ownerTimestampSchema = timestampSchema.refine(
  (value) => noControls(value) && !sameInstant(value, '0001-01-01T00:00:00Z'),
);
const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && noControls(value));
export const paymentSourceIdentitySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/^\p{White_Space}*$/u.test(value) && noControls(value));
const integer = z
  .string()
  .min(1)
  .refine((value) => /^[0-9]+$/u.test(value) && noControls(value));
const decimal = z
  .string()
  .min(1)
  .refine((value) => /^[+-]?[0-9]+(?:\.[0-9]+)?$/u.test(value) && noControls(value));
const positiveInteger = integer.refine((value) => /[1-9]/u.test(value));
const sourceRef = z.strictObject({
  materialId: identifier,
  versionId: identifier,
  contentHash: hash,
});

// Source fields retain opaque codes, lexical precision, blanks and explicit unknowns.
export const companyBankDataSchema = z.strictObject({
  orgType: z.string().nullable(),
  okfsName: z.string().nullable(),
  companyAgeYearsGradation: z.string().nullable(),
  ecoMarkLabel: z.string().nullable(),
  mainOkvedCode: z.string().nullable(),
  mainOkvedName: z.string().nullable(),
  negativeMark: z.string().nullable(),
  amountWorkersFnsGradation: z.string().nullable(),
  amountWorkersSparkGradation: z.string().nullable(),
  clType: z.string().nullable(),
  clProductRkoMark: z.string().nullable(),
  clProductGarMark: z.string().nullable(),
  clProductLoaMark: z.string().nullable(),
  clProductLeaMark: z.string().nullable(),
  clProductDepMark: z.string().nullable(),
  clProductZppMark: z.string().nullable(),
  ftsFlag: z.string().nullable(),
  ftsCountryName: z.string().nullable(),
  factoringMark: z.string().nullable(),
  revenueCompany: z.string().nullable(),
  groupId: ownerUuidSchema.nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
});
export const companyBankProfileSchema = z.strictObject({
  companyId: ownerUuidSchema,
  revisionId: identifier,
  knownAt: ownerTimestampSchema,
  bankData: companyBankDataSchema,
  sourceId: z.literal('company-bank-profile'),
  sourceRefs: z.array(sourceRef).length(1),
  provenance: z.strictObject({
    acquisition: z.literal('event_payload'),
    sourceUrl: z.null(),
    retrievedAt: ownerTimestampSchema,
    textCompleteness: z.literal('full'),
    originVersionId: z.null(),
    locator: z.null(),
  }),
});
const rawGeography = z
  .string()
  .max(16000)
  .refine((value) => !value.includes('\0'))
  .nullable();
const serviceGeography = z.strictObject({ cityName: rawGeography, rcName: rawGeography });
const ownerProvenance = z.strictObject({
  sourceId: identifier,
  versionId: identifier,
  contentHash: hash,
});
const sourceAccountFields = {
  userId: ownerUuidSchema,
  companyId: ownerUuidSchema,
  revisionId: identifier,
  knownAt: ownerTimestampSchema,
  contentHash: hash,
  sourceOwner: z.literal('user-service'),
  serviceGeography,
  provenance: ownerProvenance,
};
export const sourceAccountSchema = z.strictObject({
  ...sourceAccountFields,
  sourcePersonId: ownerUuidSchema,
});
export const viewerContextSchema = z.strictObject({
  ...sourceAccountFields,
  role: z
    .strictObject({
      id: ownerUuidSchema,
      name: z
        .string()
        .min(1)
        .max(128)
        .refine((value) => value.trim() === value && noControls(value)),
      isDefault: z.boolean(),
    })
    .nullable(),
});
const bucket = z.strictObject({ payAmt: decimal, payCnt: integer, observedRowCount: integer });
export const paymentActivitySchema = z.strictObject({
  companyId: ownerUuidSchema,
  sourceId: paymentSourceIdentitySchema,
  sourceVersionId: paymentSourceIdentitySchema,
  sourceContentHash: hash,
  asOf: ownerTimestampSchema,
  currency: z.literal('RUB'),
  period: z.strictObject({ basis: z.literal('since_january_1'), year: z.null(), end: z.null() }),
  incoming: bucket,
  outgoing: bucket,
  selfTransfer: bucket,
  coverage: z.strictObject({
    complete: z.null(),
    observedRowCount: positiveInteger,
    watermark: positiveInteger,
  }),
  provenance: z.strictObject({
    sourceKnownAt: ownerTimestampSchema,
    observedKnownAt: ownerTimestampSchema,
    basis: z.literal('observed_source_rows'),
  }),
});

export const declaredContextUsage = Object.freeze({
  evidence: 'declared_context_not_documentary_proof',
  access: 'no_access_grant',
  geography: 'declared_not_operating_coverage_or_hard_exclusion',
  payments: 'observed_activity_not_revenue_supplier_or_exposure',
  canonicalFacts: 'unchanged',
} as const);
export const declaredRecipientUsage = Object.freeze({
  ...declaredContextUsage,
  framing: 'viewer_role_only',
} as const);
export type CompanyBankProfile = z.infer<typeof companyBankProfileSchema>;
export type PaymentActivity = z.infer<typeof paymentActivitySchema>;
export type ViewerContext = z.infer<typeof viewerContextSchema>;
export type SourceAccount = Omit<z.infer<typeof sourceAccountSchema>, 'sourcePersonId'>;
export type DeclaredCompanyContext = {
  companyId: string;
  asOf: string;
  bankProfile: CompanyBankProfile | null;
  paymentActivity: PaymentActivity | null;
  usage: typeof declaredContextUsage;
};
export type DeclaredRecipientContext = {
  companyId: string;
  asOf: string;
  sourceAccount: SourceAccount;
  viewer: ViewerContext | null;
  usage: typeof declaredRecipientUsage;
};
