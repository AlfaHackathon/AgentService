import type { z } from 'zod';
import type { materialSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import type { FlowCheckpoint, FlowReasoner, NewsJob } from '../contracts/flow.ts';
import type { FlowJobClient } from '../retrieval/flow-clients.ts';
import type { NewsAnalyzer } from './company-analysis.ts';

// The service supplies the company plan; this worker owns durable execution only.
export async function runCompany(input: {
  jobId: string;
  news: z.infer<typeof materialSchema>;
  companyId: string;
  jobs: FlowJobClient;
  analyzer: NewsAnalyzer;
  reasoner: FlowReasoner;
  checkpoint: FlowCheckpoint;
  save: () => Promise<void>;
  enqueue: (raw: unknown) => Promise<NewsJob>;
}) {
  const { jobId, news, companyId, jobs, analyzer, reasoner, checkpoint, save, enqueue } = input;
  try {
    let prepared = await jobs.companyPlan(jobId, companyId);
    const relevance =
      prepared.relevanceSources.length && reasoner.relevance
        ? await reasoner.relevance(news, prepared.relevancePlan, prepared.relevanceSources)
        : undefined;
    let watch = checkpoint.watchCursors.find((cursor) => cursor.companyId === companyId);
    if (!watch) {
      watch = {
        companyId,
        afterSequence: prepared.watchAfterSequence,
        complete: false,
        followupJobIds: [],
      };
      checkpoint.watchCursors.push(watch);
      await save();
    }
    if (prepared.requiresWatchRegistration || relevance)
      prepared = await jobs.companyPlan(jobId, companyId, relevance);
    const receipt = prepared.receipt ?? (await analyzer.analyze(prepared.analysisInput));
    for (let batch = 0; !watch.complete && batch < 64; batch++) {
      const page = await jobs.companyWatch(jobId, companyId, watch.afterSequence);
      for (const request of page.requests) {
        const followup = await enqueue(request);
        if (!watch.followupJobIds.includes(followup.request.jobId))
          watch.followupJobIds.push(followup.request.jobId);
      }
      watch.afterSequence = page.afterSequence;
      watch.complete = page.complete;
      await save(); // Durable enqueue precedes cursor advancement.
    }
    if (!watch.complete) return; // A bounded catch-up continues on the next lease.
    checkpoint.companies.push({
      companyId,
      status: 'completed',
      segmentKeys: prepared.segmentKeys,
      depth: prepared.depth,
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
