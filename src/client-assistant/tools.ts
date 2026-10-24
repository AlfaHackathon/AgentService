import { useAgentStart, usePersistentState, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { createAssistantDependencies } from './configuration.ts';
import { AssistantToolSession, type AssistantToolState, initialAssistantState } from './session.ts';

const identifier = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));
const sourceHandle = v.pipe(v.string(), v.regex(/^s\d{1,10}$/));

export function useClientAssistantTools(chatId: string) {
  const [saved, persist] = usePersistentState<AssistantToolState>(
    'client-assistant-service-tools',
    initialAssistantState(),
  );
  const session = new AssistantToolSession(
    chatId,
    structuredClone(saved),
    createAssistantDependencies,
    persist,
  );
  useAgentStart(() => session.begin());
  // Model tool batches may be parallel. Serialize scope checks, handles and budgets.
  let pending: Promise<unknown> = Promise.resolve();
  const execute = (action: () => Promise<unknown>) => {
    const result = pending.then(() => session.run(action));
    pending = result;
    return result;
  };
  useTool({
    name: 'assistant_company_profile',
    description:
      'Read the current company profile of the trusted chat owner. Company and time are fixed by the server.',
    input: v.strictObject({}),
    run: () => execute(() => session.profile()),
  });
  useTool({
    name: 'assistant_search_context',
    description:
      'Search loaded context of the trusted company and permitted public market materials. Returns excerpts and exact source handles; retrieval is not exhaustive. No external web search.',
    input: v.strictObject({
      query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
    }),
    run: ({ data }) => execute(() => session.search(data.query)),
  });
  useTool({
    name: 'assistant_read_original',
    description:
      'Read a complete original using a handle returned by permitted context search. Scope, hash and time are rechecked. An expired handle requires a new search.',
    input: v.strictObject({ sourceHandle }),
    run: ({ data }) => execute(() => session.read(data.sourceHandle)),
  });
  useTool({
    name: 'assistant_news_insights',
    description:
      'Read saved current effects for one news material, only for the trusted company. Follow nextOffset for more pages; reduce limit if output exceeds the budget. Does not start analysis.',
    input: v.strictObject({
      newsMaterialId: identifier,
      offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10000)), 0),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)), 8),
    }),
    run: ({ data }) => execute(() => session.effects(data.newsMaterialId, data.offset, data.limit)),
  });
  useTool({
    name: 'assistant_analyze_news',
    description:
      'Only when the user explicitly requests analysis or reassessment: analyze one existing public news version for their company through the existing specialist analyzer. Reassessment on a changed source requires its permitted triggerSourceHandle. An existing receipt is reused; the same version is not forcibly rewritten. Starts at most one new analysis per message. Returns a receipt summary, never a global job or role projection. Never retry an unknown outcome automatically.',
    input: v.strictObject({
      newsMaterialId: identifier,
      newsVersionId: identifier,
      triggerSourceHandle: v.optional(sourceHandle),
    }),
    run: ({ data }) =>
      execute(() =>
        session.analyze(data.newsMaterialId, data.newsVersionId, data.triggerSourceHandle),
      ),
  });
}
