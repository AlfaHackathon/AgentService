import { z } from 'zod';
import { paymentSourceIdentitySchema } from '../../contracts/declared-context.ts';
export const serviceUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, 'Expected an HTTP(S) service URL without credentials, query or fragment');

export const internalSecret = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0);

export const serviceSettingsSchema = z
  .object({
    INTERNAL_SECRET: internalSecret,
    CONTEXT_SERVICE_URL: serviceUrl,
    COMPANY_SERVICE_URL: serviceUrl,
    INSIGHT_SERVICE_URL: serviceUrl,
    NEWS_OWNER_CONTEXT_ENABLED: z.enum(['true', 'false']).default('false'),
    USER_SERVICE_URL: serviceUrl.optional(),
    NEWS_PAYMENT_SOURCE_ID: paymentSourceIdentitySchema.optional(),
    NEWS_PAYMENT_SOURCE_VERSION_ID: paymentSourceIdentitySchema.optional(),
  })
  .superRefine((value, context) => {
    if (!!value.NEWS_PAYMENT_SOURCE_ID !== !!value.NEWS_PAYMENT_SOURCE_VERSION_ID)
      context.addIssue({
        code: 'custom',
        message: 'Payment source identity and version must be configured together.',
      });
  });
export type ServiceSettings = z.infer<typeof serviceSettingsSchema>;
