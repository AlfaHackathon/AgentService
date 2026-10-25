import { useAgentStart, usePersistentState, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { createAssistantDependencies } from './configuration.ts';
import { AssistantToolSession, type AssistantToolState, initialAssistantState } from './session.ts';

const identifier = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));
const sourceHandle = v.pipe(v.string(), v.regex(/^s\d{1,10}$/));
const newsHandle = v.pipe(v.string(), v.regex(/^n\d{1,10}$/));

export const analyzeNewsInput = v.pipe(
  v.strictObject({
    newsHandle: v.optional(newsHandle),
    newsMaterialId: v.optional(identifier),
    newsVersionId: v.optional(identifier),
    triggerSourceHandle: v.optional(sourceHandle),
  }),
  v.check(
    (data) =>
      data.newsHandle !== undefined
        ? data.newsMaterialId === undefined && data.newsVersionId === undefined
        : data.newsMaterialId !== undefined && data.newsVersionId !== undefined,
    'Supply a newsHandle or an exact newsMaterialId/newsVersionId pair, never both.',
  ),
);

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
    name: 'assistant_search_news',
    description:
      'Search already admitted public news at the server snapshot. Returns bounded candidates with newsHandle and provenance, never a full text or exhaustive corpus. Requires the Context news catalog; unavailable is not an empty result. Does not fetch the web or start analysis.',
    input: v.strictObject({
      query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
    }),
    run: ({ data }) => execute(() => session.searchNews(data.query)),
  });
  useTool({
    name: 'assistant_read_news',
    description:
      'Read the exact admitted public news version selected by newsHandle. The server rechecks membership, public scope, hash and snapshot. Stored text can be lead, excerpt or unknown; never describe it as full unless provenance says full. Does not start analysis.',
    input: v.strictObject({ newsHandle }),
    run: ({ data }) => execute(() => session.readNews(data.newsHandle)),
  });
  useTool({
    name: 'assistant_news_insights',
    description:
      'Read saved current effects for one news material, only for the trusted company. Follow nextOffset for more pages; reduce limit if output exceeds the budget. Does not start analysis. Company importance is currentRevision.companyImportance: score 1..5 with rationale; missing/null means not assessed. Never infer it from legacy impact.importance or priority.',
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
      'Only when the user explicitly requests analysis or reassessment: use newsHandle from news search/read, or an exact known newsMaterialId/newsVersionId pair, to analyze one existing public news version for their company through the existing specialist analyzer. Reassessment on a changed source requires its permitted triggerSourceHandle. An existing receipt is reused; the same version is not forcibly rewritten. Starts at most one new analysis per message. Returns a receipt summary, never a global job or role projection. Never retry an unknown outcome automatically.',
    input: analyzeNewsInput,
    run: ({ data }) =>
      execute(() => {
        if (data.newsHandle)
          return session.analyzeSelectedNews(data.newsHandle, data.triggerSourceHandle);
        // The input check requires both identifiers for the legacy selector.
        return session.analyze(
          data.newsMaterialId ?? '',
          data.newsVersionId ?? '',
          data.triggerSourceHandle,
        );
      }),
  });
}
