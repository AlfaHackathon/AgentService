import {
  type AnalysisReceipt,
  type AnalysisRequest,
  type NewsReasoner,
  reasoningOutputSchema,
} from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import { validateFinalCalculations } from '../contracts/final-calculation.ts';
import { instantAfter, sameInstant } from '../contracts/timestamps.ts';
import type { ContextClient } from '../retrieval/context-client.ts';
import type { InsightClient } from '../retrieval/insight-client.ts';
import { sourceKey, validateReferences } from './draft-validation.ts';

type Dependencies = {
  context: ContextClient;
  insights: InsightClient;
  reasoner: NewsReasoner;
};
export type AnalysisResult = AnalysisReceipt & {
  reasoningInvoked: boolean;
  contextComplete?: boolean;
};

export class NewsAnalyzer {
  readonly dependencies: Dependencies;
  private readonly inFlight = new Map<string, Promise<AnalysisResult>>();

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }
  recipients(asOf: string, after?: string, materialId?: string) {
    return this.dependencies.insights.recipients(asOf, after, materialId);
  }
  analyze(input: AnalysisRequest): Promise<AnalysisResult> {
    const key = JSON.stringify(input);
    const running = this.inFlight.get(key);
    if (running)
      return running.then((result) => ({ ...result, duplicate: true, reasoningInvoked: false }));
    const work = this.run(input);
    this.inFlight.set(key, work);
    return work.finally(() => {
      if (this.inFlight.get(key) === work) this.inFlight.delete(key);
    });
  }

  private async run(input: AnalysisRequest): Promise<AnalysisResult> {
    const { context: contextClient, insights, reasoner } = this.dependencies;
    const session = await insights.analysisSession(input);
    if (session.receipt)
      return {
        ...session.receipt,
        reasoningInvoked: false,
        contextComplete: session.receipt.contextComplete ?? false,
      };
    let context = await contextClient.getContext(input);
    if (input.trigger) {
      const source = await contextClient.material(
        input.trigger.materialId,
        input.trigger.versionId,
      );
      if (
        instantAfter(source.knownAt, input.asOf) ||
        (source.companyIds.length && !source.companyIds.includes(input.companyId))
      )
        throw new NewsAnalysisError(
          422,
          'TRIGGER_SCOPE',
          'The source trigger is unavailable at this scope and time',
        );
      if (!context.materials.some((m) => sourceKey(m) === sourceKey(source)))
        context = { ...context, materials: [...context.materials, source] };
    }
    if (
      context.news.materialId !== input.newsMaterialId ||
      context.news.versionId !== input.newsVersionId ||
      !sameInstant(context.coverage.asOf, input.asOf) ||
      context.news.kind !== 'news' ||
      [context.news, ...context.materials].some(
        (s) =>
          instantAfter(s.knownAt, input.asOf) ||
          (s.companyIds.length > 0 && !s.companyIds.includes(input.companyId)) ||
          (s.kind === 'company' && !s.companyIds.includes(input.companyId)),
      )
    )
      throw new NewsAnalysisError(
        502,
        'UPSTREAM_CONTRACT',
        'Context scope does not match the request',
      );
    const before = {
      effects: session.previousEffects,
      stateVersion: session.stateVersion ?? undefined,
    };
    const previousEffects = session.previousEffects;
    const reasoningInput: import('../contracts/analysis.ts').ReasoningInput = {
      request: input,
      context,
      previousEffects,
    };
    const firstResult = reasoningOutputSchema.safeParse({
      drafts: await reasoner.analyze(reasoningInput),
    });
    if (!firstResult.success)
      throw new NewsAnalysisError(
        502,
        'INVALID_REASONING_RESULT',
        'Reasoner returned an invalid draft contract',
      );
    let first = firstResult.data.drafts;
    const refs = (bundle: typeof context) =>
      [bundle.news, ...bundle.materials].map((s) => ({
        materialId: s.materialId,
        versionId: s.versionId,
        contentHash: s.contentHash,
      }));
    const retrievalTrace = [
      {
        round: 0,
        queries: input.retrievalQueries ?? [],
        retrievedSources: refs(context),
        stopReason: reasoner.retrievalMode === 'agent_tools' ? 'agent_tools' : 'initial',
      },
    ];
    const stop = (reason: string) => {
      const last = retrievalTrace.at(-1);
      if (last) last.stopReason = reason;
    };
    const usedQueries = new Set<string>();
    for (let round = 1; reasoner.retrievalMode !== 'agent_tools' && round <= 2; round++) {
      validateReferences(first, context);
      const missing = first
        .flatMap((d) => d.assessment?.unknowns ?? [])
        .filter((f) => f.query && !usedQueries.has(f.query));
      if (!missing.length || context.coverage.complete) {
        stop(missing.length ? 'available_corpus_exhausted' : 'no_requested_fact');
        break;
      }
      const facts = missing.slice(0, 3);
      const queries = [...new Set(facts.flatMap((f) => (f.query ? [f.query] : [])))];
      for (const q of queries) usedQueries.add(q);
      const scopes = new Set(facts.map((f) => f.scope));
      const found = await contextClient.followUp(
        input,
        queries,
        scopes.size === 1 ? facts[0]?.scope : undefined,
        [...new Set(facts.flatMap((f) => (f.materialId ? [f.materialId] : [])))],
      );
      if (
        sourceKey(found.news) !== sourceKey(context.news) ||
        !sameInstant(found.coverage.asOf, input.asOf) ||
        [found.news, ...found.materials].some(
          (s) =>
            instantAfter(s.knownAt, input.asOf) ||
            (s.companyIds.length > 0 && !s.companyIds.includes(input.companyId)) ||
            (s.kind === 'company' && !s.companyIds.includes(input.companyId)),
        )
      )
        throw new NewsAnalysisError(
          502,
          'FOLLOWUP_SCOPE',
          'Follow-up changed the permitted source scope',
        );
      const known = new Set(refs(context).map(sourceKey));
      const fresh = found.materials.filter((s) => !known.has(sourceKey(s)));
      retrievalTrace.push({
        round,
        queries,
        retrievedSources: refs(found),
        stopReason: fresh.length ? 'new_evidence' : 'no_new_evidence',
      });
      if (!fresh.length) break;
      const merged = { ...found, materials: [...context.materials, ...fresh] };
      if (JSON.stringify(merged).length > 120000) {
        stop('context_budget');
        break;
      }
      context = merged;
      reasoningInput.context = context;
      first = reasoningOutputSchema.parse({
        drafts: await reasoner.analyze(reasoningInput),
      }).drafts;
      if (round === 2) stop('round_budget');
    }
    // Preliminary candidates are not writes. Let the final review consolidate
    // repeated identities; source binding remains mandatory before any preview.
    validateReferences(first, context);
    const proposed = reasoningOutputSchema.safeParse({
      drafts: reasoner.review
        ? await reasoner.review(reasoningInput, first, await insights.preview(first))
        : first,
    });
    if (!proposed.success)
      throw new NewsAnalysisError(
        502,
        'INVALID_REASONING_RESULT',
        'Reasoner returned an invalid draft contract',
      );
    validateReferences(proposed.data.drafts, context);
    if (reasoner.review) validateFinalCalculations(first, proposed.data.drafts);
    const drafts = await insights.prepare(input, proposed.data.drafts, before.stateVersion);
    validateReferences(drafts, context);
    // InsightService commits every revision and completion receipt in one transaction,
    // including empty batches. Omitted previous effects are never deleted or zeroed.
    const saved = await insights.saveAnalysis({
      ...input,
      drafts,
      contextComplete: context.coverage.complete,
      retrievalTrace:
        reasoner.retrievalMode === 'agent_tools'
          ? [...retrievalTrace.slice(0, 1), ...(reasoningInput.toolTrace ?? [])].slice(-4)
          : retrievalTrace,
      expectedStateVersion: before.stateVersion,
    });
    return { ...saved, reasoningInvoked: true, contextComplete: context.coverage.complete };
  }
}
