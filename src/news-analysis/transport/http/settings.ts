import { z } from 'zod';
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

export const serviceSettingsSchema = z.object({
  INTERNAL_SECRET: internalSecret,
  CONTEXT_SERVICE_URL: serviceUrl,
  INSIGHT_SERVICE_URL: serviceUrl,
});
export type ServiceSettings = z.infer<typeof serviceSettingsSchema>;
