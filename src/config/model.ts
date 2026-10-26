import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { setProvider, useModel } from '@flue/runtime';
import { z } from 'zod';
import { compactNewsToolFeedback } from './tool-feedback.ts';

const modelEnvironment = z
  .object({
    LLM_BASE_URL: z.url().refine((value) => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    }, 'Expected an HTTP(S) endpoint without embedded credentials'),
    LLM_API_KEY: z.string().min(1),
    LLM_MODEL: z.string().trim().min(1),
    LLM_CONTEXT_WINDOW: z.coerce.number().int().min(8192).default(128000),
    LLM_MAX_TOKENS: z.coerce.number().int().positive().default(8192),
    LLM_REASONING: z.enum(['true', 'false']).default('false'),
  })
  .refine(
    (value) => value.LLM_MAX_TOKENS < value.LLM_CONTEXT_WINDOW,
    'Output limit must fit context',
  );

const settings = modelEnvironment.parse(process.env);

export function createModelProvider(environment: NodeJS.ProcessEnv = process.env) {
  const settings = modelEnvironment.parse(environment);
  const api = openAICompletionsApi();
  return createProvider({
    id: 'project',
    auth: {
      apiKey: {
        name: 'Project LLM API key',
        resolve: async () => ({ auth: { apiKey: settings.LLM_API_KEY } }),
      },
    },
    models: [
      {
        id: settings.LLM_MODEL,
        name: settings.LLM_MODEL,
        api: 'openai-completions',
        provider: 'project',
        baseUrl: settings.LLM_BASE_URL.replace(/\/$/, ''),
        reasoning: settings.LLM_REASONING === 'true',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: settings.LLM_CONTEXT_WINDOW,
        maxTokens: settings.LLM_MAX_TOKENS,
      },
    ],
    api: {
      ...api,
      stream: (model, context, options) =>
        api.stream(model, compactNewsToolFeedback(context), options),
      streamSimple: (model, context, options) =>
        api.streamSimple(model, compactNewsToolFeedback(context), options),
    },
  });
}

export const modelProvider = createModelProvider();

// Agent modules also load this registration under `flue run`, without app.ts.
setProvider(modelProvider);

export function useProjectModel(): void {
  useModel(`project/${settings.LLM_MODEL}`, {
    thinkingLevel: settings.LLM_REASONING === 'true' ? 'medium' : 'off',
  });
}
