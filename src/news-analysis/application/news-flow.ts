import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { materialSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import {
  checkpointSchema,
  type FlowReasoner,
  flowRequestSchema,
  type NewsJob,
} from '../contracts/flow.ts';
import type { CompanyClient } from '../retrieval/company-client.ts';
import type { FlowContextClient, FlowJobClient } from '../retrieval/flow-clients.ts';
import type { NewsAnalyzer } from './company-analysis.ts';
import { runCompany } from './company-run.ts';
import { selectCompanies } from './company-selection.ts';
import { projectJobResult } from './job-projection.ts';
import { analyzeSegmentBatch } from './segment-analysis.ts';
import { refreshSegmentBatches } from './signal-cache.ts';

type Dependencies = {
  context: FlowContextClient;
  companies: CompanyClient;
  jobs: FlowJobClient;
  analyzer: NewsAnalyzer;
  reasoner: FlowReasoner;
};
const materialKey = (s: { materialId: string; versionId: string; contentHash: string }) =>
  JSON.stringify([s.materialId, s.versionId, s.contentHash]);

export class NewsFlow {
  private readonly workerId = `news-worker-${randomUUID()}`;
  private active = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 5000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async enqueue(raw: unknown) {
    const request = flowRequestSchema.parse(raw);
    request.groupIds = [...new Set(request.groupIds)].sort();
    request.personIds = [...new Set(request.personIds)].sort();
    const jobId = `news_${createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 40)}`;
    const job = await this.deps.jobs.create(jobId, request);
    this.start();
    return job;
  }
  get(id: string) {
    return this.deps.jobs.get(id);
  }
  async ingest(raw: unknown) {
    return this.enqueue(await this.deps.context.admitNews(raw));
  }
  async tick() {
    if (this.active) return;
    this.active = true;
    try {
      const job = await this.deps.jobs.claim(this.workerId);
      if (job) await this.execute(job);
    } finally {
      this.active = false;
    }
  }
  private async execute(initial: NewsJob) {
    const { context, companies, jobs, analyzer, reasoner } = this.deps;
    let job = initial;
    const request = flowRequestSchema.parse(job.request.parameters);
    const checkpoint = checkpointSchema.parse(job.checkpoint);
    // A retry keeps successful canonical writes and the plan, but failed work must be admitted again.
    if (checkpoint.companies.some((company) => company.status === 'failed')) {
      checkpoint.companies = checkpoint.companies.filter(
        (company) => company.status === 'completed',
      );
    }
    // Raw model proposals survive retries; Insight validates their opaque scope version.
    checkpoint.roleViews = checkpoint.roleViews.filter(
      (view) =>
        typeof view === 'object' &&
        view !== null &&
        'status' in view &&
        (view.status === 'completed' || view.status === 'proposed'),
    );
    let writes: Promise<unknown> = Promise.resolve();
    let leaseError: unknown;
    const save = (
      status: 'running' | 'partial' | 'completed' | 'failed' = 'running',
      error?: string,
    ) => {
      const next = writes.then(async () => {
        if (leaseError) throw leaseError;
        job = await jobs.update(job, checkpoint, status, error);
      });
      writes = next.catch((error) => {
        leaseError = error;
      });
      return next;
    };
    const heartbeat = setInterval(() => {
      void save().catch(() => {});
    }, 20000);
    heartbeat.unref();
    try {
      const news = await context.news(request);
      await context.sync();
      if (!checkpoint.plan) {
        if (request.projectionOnly)
          checkpoint.plan = {
            eventSummary: 'Canonical state projection refresh',
            queries: ['canonical projection'],
            generalInsights: [],
          };
      }
      if (!checkpoint.plan) {
        const publicSearch = await context.search(
          `${news.title}\n${news.text.slice(0, 4000)}`,
          request.asOf,
          true,
        );
        const refs = new Map(
          publicSearch.hits
            .flatMap((h) => [...(h.relatedVersions ?? []), ...h.sourceRefs])
            .map((r) => [materialKey(r), r]),
        );
        const sources: z.infer<typeof materialSchema>[] = [];
        let size = news.text.length;
        for (const source of await context.publicSources(
          [...refs.values()].slice(0, 8),
          request.asOf,
        )) {
          if (size + source.text.length > 90000) break;
          sources.push(source);
          size += source.text.length;
        }
        const plan = await reasoner.plan(news, sources, request.textCompleteness, {
          asOf: request.asOf,
        });
        const available = new Set([news, ...sources].map(materialKey));
        const trigger = materialKey(news);
        for (const insight of plan.generalInsights)
          if (
            !insight.sourceRefs.some((r) => materialKey(r) === trigger) ||
            insight.sourceRefs.some((r) => !available.has(materialKey(r)))
          )
            throw new NewsAnalysisError(
              422,
              'GENERAL_INSIGHT_SOURCE',
              'A general insight must cite the triggering news and supplied public originals',
            );
        checkpoint.plan = plan;
        await save();
      }
      const plan = checkpoint.plan;
      if (!plan) throw new Error('Missing durable news plan');
      if (!checkpoint.selectedCompanyIds)
        await selectCompanies(companies, analyzer, request, checkpoint, plan);
      else if (checkpoint.recipientCursor) {
        const page = await analyzer.recipients(request.asOf, checkpoint.recipientCursor);
        checkpoint.pendingCompanyIds = [
          ...new Set([...(checkpoint.pendingCompanyIds ?? []), ...page.companyIds]),
        ];
        checkpoint.recipientCursor = page.nextCursor;
      }
      const selectedCompanyIds = [
        ...new Set([
          ...(checkpoint.selectedCompanyIds ?? []),
          ...(checkpoint.pendingCompanyIds ?? []),
        ]),
      ];
      if (!selectedCompanyIds) throw new Error('Missing durable company selection');
      checkpoint.selectedCompanyIds = selectedCompanyIds;
      await save();
      if (!request.projectionOnly && reasoner.segments) {
        const segments = await companies.segments(request.asOf, selectedCompanyIds);
        checkpoint.segmentBatches = refreshSegmentBatches(
          checkpoint.segmentBatches,
          segments,
          !!reasoner.signals,
        );
        const completedKeys = new Set(
          checkpoint.segmentBatches.flatMap((b) => b.segments.map((s) => s.key)),
        );
        const pendingSegments = segments.filter((s) => !completedKeys.has(s.key));
        for (let i = 0; i < pendingSegments.length; i += 8) {
          checkpoint.segmentBatches.push(
            await analyzeSegmentBatch(
              context,
              reasoner.segments,
              news,
              pendingSegments.slice(i, i + 8),
              request.asOf,
              ...(reasoner.signals
                ? [
                    {
                      inventories: checkpoint.signalInventories,
                      extract: reasoner.signals,
                      save: () => save(),
                    },
                  ]
                : []),
            ),
          );
          await save();
        }
      }
      const queue = selectedCompanyIds
        .filter((id) => !checkpoint.companies.some((r) => r.companyId === id))
        .slice(0, request.companyBudget);
      // Independent company contexts run concurrently; checkpoint writes remain serialized.
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (cursor < queue.length) {
            if (leaseError) throw leaseError;
            const companyId = queue[cursor++];
            if (!companyId) break;
            await runCompany({
              jobId: job.request.jobId,
              news,
              companyId,
              jobs,
              analyzer,
              reasoner,
              checkpoint,
              save: () => save(),
              enqueue: (raw) => this.enqueue(raw),
            });
          }
        }),
      );
      checkpoint.pendingCompanyIds = selectedCompanyIds.filter(
        (id) => !checkpoint.companies.some((c) => c.companyId === id),
      );
      await projectJobResult({
        jobId: job.request.jobId,
        jobs,
        reasoner,
        checkpoint,
        asOf: request.asOf,
        save: () => save(),
        ensureLease: () => {
          if (leaseError) throw leaseError;
        },
      });
      clearInterval(heartbeat);
      const failed =
        checkpoint.companies.some((company) => company.status === 'failed') ||
        checkpoint.roleViews.some(
          (view) =>
            typeof view === 'object' &&
            view !== null &&
            'status' in view &&
            view.status === 'failed',
        );
      await save(
        failed
          ? 'failed'
          : checkpoint.pendingCompanyIds.length || checkpoint.recipientCursor
            ? 'partial'
            : 'completed',
        failed ? 'PARTIAL_ANALYSIS_FAILED' : undefined,
      );
    } catch (error) {
      clearInterval(heartbeat);
      if (!leaseError)
        await save('failed', error instanceof NewsAnalysisError ? error.code : 'NEWS_FLOW_FAILED');
    } finally {
      clearInterval(heartbeat);
      await writes;
    }
  }
}
