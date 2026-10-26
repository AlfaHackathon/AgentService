import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Agent, type ConversationStreamChunk, init } from '@flue/runtime';
import { isTimeoutCause, NewsAnalysisError } from '../contracts/errors.ts';
import type { ToolEvidence, ToolScope } from '../retrieval/tool-evidence.ts';
import { terminalValidation } from './tools/validation-feedback.ts';

// The application/standalone worker owns the single Flue runtime and provider.
// Each phase gets its own conversation: company and role contexts never coalesce.
async function runNewsAgentAttempt(
  agent: Agent,
  content: string,
  task: {
    evidenceSources?: Array<{
      materialId: string;
      versionId: string;
      contentHash: string;
      text: string;
    }>;
    signalUnits?: import('../retrieval/source-units.ts').SourceUnit[];
    signalDraft?: import('../contracts/signals.ts').SignalInventory[];
    segmentCatalog?: {
      segmentKeys: string[];
      news: { materialId: string; versionId: string; contentHash: string };
      sources: Array<{ materialId: string; versionId: string; contentHash: string }>;
    };
    instructions: string;
    objectHandles?: string[];
    sourceHandles?: string[];
    questionHandles?: string[];
    serviceTools?: ToolScope;
    companyScope?: import('./company-result.ts').CompanyResultScope;
  },
  options: {
    environment: NodeJS.ProcessEnv;
    phase: string;
    errorCode: string;
    timeoutMs?: number;
    onEvidence?: (evidence: ToolEvidence) => void;
  },
): Promise<unknown> {
  const conversationId = randomUUID();
  const handle = init(agent, { id: conversationId, uid: null });
  const events: ConversationStreamChunk[] = [];
  const startedAt = Date.now();
  let metadata: Record<string, unknown> | undefined;
  let failure: { name: string; message: string } | undefined;
  const traceDirectory = options.environment.NEWS_TRACE_DIRECTORY;
  const turnTools = new Map<string, string[]>();
  const toolTurns = new Map<string, { turn: string; name: string }>();
  const acceptedResultTurns = new Set<string>();
  const resultTools = new Set([
    'extract_source_signals',
    'review_source_signals',
    'assess_evidence_relevance',
    'submit_news_analysis',
    'plan_news_insights',
    'project_role_actions',
  ]);
  let companySubmissions = 0;
  let lastValidation: NewsAnalysisError | undefined;
  let modelTurn = '';
  let turnSequence = 0;
  const timeoutMs = Math.max(180000, Math.min(options.timeoutMs ?? 180000, 360000));
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const receipt = await handle.dispatch({
      initialData: {
        objectHandles: [],
        sourceHandles: [],
        ...task,
        ...(task.serviceTools
          ? { serviceTools: { ...task.serviceTools, deadlineAt: startedAt + timeoutMs } }
          : {}),
      },
      message: content,
    });
    const reply = await handle.read(receipt, {
      signal,
      onEvent: (event) => {
        if (traceDirectory) events.push(event);
        if (event.type === 'message-started')
          modelTurn = event.turnId ?? `model-turn-${++turnSequence}`;
        if (event.type === 'tool-input') {
          if (event.toolName === 'submit_news_analysis' && ++companySubmissions > 2)
            throw new Error('Company result submission budget exhausted after 2 submissions');
          const tools = turnTools.get(modelTurn) ?? [];
          tools.push(event.toolName);
          turnTools.set(modelTurn, tools);
          toolTurns.set(event.toolCallId, { turn: modelTurn, name: event.toolName });
        }
        if (
          event.type === 'tool-output-error' &&
          companySubmissions >= 2 &&
          toolTurns.get(event.toolCallId)?.name === 'submit_news_analysis'
        )
          throw new Error('Company result submission budget exhausted after 2 submissions');
        if (event.type === 'tool-output') {
          const call = toolTurns.get(event.toolCallId);
          if (call?.name === 'submit_news_analysis')
            lastValidation = terminalValidation(event.output);
          if (call && resultTools.has(call.name)) acceptedResultTurns.add(call.turn);
        }
      },
    });
    metadata = reply.metadata;
    if ([...acceptedResultTurns].some((turn) => (turnTools.get(turn)?.length ?? 0) > 1))
      throw new Error(
        'A final result must be the only tool in its model turn, after reading prior evidence results',
      );
    const values = reply.data.result;
    if (values?.length !== 1)
      throw new Error('The Flue phase did not produce exactly one structured result');
    const evidence = reply.data.evidence?.at(-1);
    if (evidence) options.onEvidence?.(evidence as ToolEvidence);
    return values[0];
  } catch (error) {
    failure =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'UnknownError', message: 'Phase failed' };
    // Cancelling read alone leaves work running; record an actual runtime abort.
    await handle.abort().catch(() => {});
    if (lastValidation && !signal.aborted && !isTimeoutCause(error)) throw lastValidation;
    throw new NewsAnalysisError(
      502,
      signal.aborted || isTimeoutCause(error) ? 'REASONING_TIMEOUT' : options.errorCode,
      'Flue agent did not return one valid phase result',
    );
  } finally {
    if (traceDirectory) {
      const usage = events.findLast(
        (event) => event.type === 'data-part' && event.name === 'usage',
      );
      if (!metadata && usage?.type === 'data-part') metadata = { usage: usage.data };
      await mkdir(traceDirectory, { recursive: true });
      const secrets = [
        options.environment.LLM_API_KEY,
        options.environment.INTERNAL_SECRET,
        options.environment.DATABASE_URL,
      ].filter((value): value is string => !!value);
      // Prompt event text is itself JSON. Redact both literal and embedded-JSON forms
      // before the trace serializer adds another layer of escaping.
      const patterns = [
        ...new Set(secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])),
      ];
      const trace = JSON.stringify(
        {
          phase: options.phase,
          agentName: agent.agentName,
          conversationId,
          startedAt: new Date(startedAt).toISOString(),
          elapsedMs: Date.now() - startedAt,
          metadata,
          failure,
          events,
        },
        (_key, value: unknown) =>
          typeof value === 'string'
            ? patterns.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), value)
            : value,
      );
      await writeFile(join(traceDirectory, `${Date.now()}-${conversationId}.json`), trace, 'utf8');
    }
  }
}

// A timed-out read is aborted before a new isolated conversation is admitted.
// Structured-output or applicability failures are not a new-phase retry policy.
export async function runNewsAgent(
  ...args: Parameters<typeof runNewsAgentAttempt>
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runNewsAgentAttempt(...args);
    } catch (error) {
      if (
        !(error instanceof NewsAnalysisError) ||
        error.code !== 'REASONING_TIMEOUT' ||
        attempt >= 3
      )
        throw error;
      const delayMs = 1000 * 2 ** (attempt - 1);
      console.warn(
        JSON.stringify({
          event: 'news.model_retry',
          phase: args[3].phase,
          attempt,
          nextAttempt: attempt + 1,
          maximumAttempts: 3,
          delayMs,
          code: error.code,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
