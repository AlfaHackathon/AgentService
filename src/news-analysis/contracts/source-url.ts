import { z } from 'zod';

// Only an explicit publisher URL supplied by the owner, never an ID-derived address.
export const sourceUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^https?:\/\//i)
  .refine(
    (value) =>
      !/[\s\\]/u.test(value) &&
      ![...value].some((c) => {
        const code = c.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      }),
  )
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname.length > 0 &&
        url.username.length === 0 &&
        url.password.length === 0
      );
    } catch {
      return false;
    }
  });
