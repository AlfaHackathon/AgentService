import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:/.test(value)),
});

export function readEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return environmentSchema.parse(env);
}
