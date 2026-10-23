import type { z } from 'zod';
import type { materialSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import type {
  companyProfileSchema,
  FlowCheckpoint,
  FlowReasoner,
  FlowRequest,
  NewsJob,
  NewsPlan,
} from '../contracts/flow.ts';
import { instantAfter } from '../contracts/timestamps.ts';
import type { FlowContextClient } from '../retrieval/flow-clients.ts';
import type { NewsAnalyzer } from './company-analysis.ts';
import { chooseDepth } from './depth-policy.ts';
import { inspectEvidenceRelevance } from './evidence-relevance.ts';

// One company's depth decision, durable watch registration and canonical receipt.
// The caller controls concurrency and serializes checkpoint writes.
export async function runCompany(input: {
  companyId: string;
  context: FlowContextClient;
  analyzer: NewsAnalyzer;
  reasoner: FlowReasoner;
  profiles: Map<string, z.infer<typeof companyProfileSchema>>;
  request: FlowRequest;
  checkpoint: FlowCheckpoint;
  plan: NewsPlan;
  news: z.infer<typeof materialSchema>;
  save: () => Promise<void>;
  enqueue: (raw: unknown) => Promise<NewsJob>;
}) {
  const {
    companyId,
    context,
    analyzer,
    reasoner,
    profiles,
    request,
    checkpoint,
    plan,
    news,
    save,
    enqueue,
  } = input;
  try {
    const profile = profiles.get(companyId.toLowerCase());
    const linkedSignalIds = new Set(
      checkpoint.segmentBatches.flatMap(
        (batch) =>
          batch.plan.segmentCoverage
            ?.filter((row) =>
              batch.segments.some(
                (segment) =>
                  segment.key === row.segmentKey && segment.companyIds.includes(companyId),
              ),
            )
            .flatMap((row) =>
              row.insightIndexes.flatMap(
                (index) => batch.plan.generalInsights[index]?.signalIds ?? [],
              ),
            ) ?? [],
      ),
    );
    const scopedPlan = {
      ...plan,
      ...(plan.mechanisms?.length
        ? {
            mechanisms: [
              ...new Set([
                ...plan.mechanisms,
                ...checkpoint.signalInventories.flatMap((i) =>
                  i.signals
                    .filter((s) => linkedSignalIds.has(s.signalId))
                    .flatMap((s) => s.mechanisms),
                ),
              ]),
            ],
          }
        : {}),
    };
    const analysisInput = {
      companyId,
      newsMaterialId: request.newsMaterialId,
      newsVersionId: request.newsVersionId,
      asOf: request.asOf,
      retrievalQueries: plan.queries,
      ...(request.retrievalLimit ? { retrievalLimit: request.retrievalLimit } : {}),
      ...(!request.trigger && scopedPlan.mechanisms?.length
        ? { mechanisms: scopedPlan.mechanisms }
        : {}),
      ...(request.trigger ? { trigger: request.trigger } : {}),
      ...(profile?.bankProfileId ? { bankProfileId: profile.bankProfileId } : {}),
    };
    const previous = await analyzer.currentEffects(analysisInput);
    const inventory = await context.evidence(companyId, request.asOf);
    let depth = chooseDepth({
      companyId,
      request,
      plan: scopedPlan,
      inventory,
      previous,
      hasProfile: !!profile,
      newsCorrection: !!news.correctsVersionId,
    });
    const classifyRelevance = reasoner.relevance;
    if (depth.reason === 'own_originals' && classifyRelevance) {
      const relevance = await inspectEvidenceRelevance(context, inventory, (sources) =>
        classifyRelevance(news, scopedPlan, sources),
      );
      if (relevance)
        depth = chooseDepth({
          companyId,
          request,
          plan: scopedPlan,
          inventory,
          previous,
          hasProfile: !!profile,
          newsCorrection: !!news.correctsVersionId,
          relevance,
        });
    }
    let watch = checkpoint.watchCursors.find((w) => w.companyId === companyId);
    if (!watch) {
      watch = {
        companyId,
        afterSequence: inventory.watchAfterSequence,
        complete: false,
        followupJobIds: [],
      };
      checkpoint.watchCursors.push(watch);
      await save(); // Registration cursor survives a crash before the receipt commit.
    }
    let receipt: Awaited<ReturnType<NewsAnalyzer['analyze']>>;
    if (depth.level === 'canonical_projection')
      try {
        receipt = await analyzer.readCompany(analysisInput);
      } catch (error) {
        if (!(error instanceof NewsAnalysisError) || error.code !== 'NO_CANONICAL_STATE')
          throw error;
        receipt = await analyzer.recordApplicability(analysisInput);
      }
    else if (depth.level === 'company_deep') receipt = await analyzer.analyze(analysisInput);
    else {
      try {
        receipt = await analyzer.recordApplicability(analysisInput);
      } catch (error) {
        if (
          !(error instanceof NewsAnalysisError) ||
          !['DEPTH_ESCALATION_REQUIRED', 'stale_company_snapshot'].includes(error.code)
        )
          throw error;
        depth = {
          ...depth,
          level: 'company_deep',
          reason: 'prior_canonical_state',
          missingFacts: [],
        };
        receipt = await analyzer.analyze(analysisInput);
      }
    }
    if (watch && !watch.complete) {
      let caughtUp = false;
      for (let n = 0; n < 64; n++) {
        const event = (await context.changes(watch.afterSequence))[0];
        if (!event) {
          watch.complete = true;
          caughtUp = true;
          break;
        }
        if (
          (event.category === 'material:company' && event.companyIds.includes(companyId)) ||
          (['material:market', 'group', 'role', 'company'].includes(event.category) &&
            (event.companyIds.length === 0 || event.companyIds.includes(companyId)))
        ) {
          const followup = await enqueue({
            newsMaterialId: request.newsMaterialId,
            newsVersionId: request.newsVersionId,
            asOf: instantAfter(event.knownAt, request.asOf) ? event.knownAt : request.asOf,
            targetCompanyIds: [companyId],
            groupIds: request.groupIds,
            personIds: request.personIds,
            companyBudget: 4,
            textCompleteness: request.textCompleteness,
            ...(event.category.startsWith('material:')
              ? { trigger: { materialId: event.entityId, versionId: event.versionId } }
              : { projectionOnly: true }),
          });
          if (!watch.followupJobIds.includes(followup.request.jobId))
            watch.followupJobIds.push(followup.request.jobId);
        }
        watch.afterSequence = event.sequence;
        await save(); // Enqueue precedes the checkpoint cursor; replay is idempotent.
      }
      if (!caughtUp) return; // A bounded partial batch continues catch-up after restart.
    }
    checkpoint.companies.push({
      companyId,
      status: 'completed',
      segmentKeys: checkpoint.segmentBatches.flatMap((b) =>
        b.segments.filter((s) => s.companyIds.includes(companyId)).map((s) => s.key),
      ),
      depth,
      receipt,
      contextComplete: receipt.contextComplete ?? false,
    });
  } catch (error) {
    checkpoint.companies.push({
      companyId,
      status: 'failed',
      error:
        error instanceof NewsAnalysisError
          ? `${error.code}: ${error.message}`
          : 'COMPANY_ANALYSIS_FAILED',
    });
  }
  await save();
}
