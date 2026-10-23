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
import { instantAfter } from '../contracts/timestamps.ts';
import type { FlowContextClient, FlowJobClient } from '../retrieval/flow-clients.ts';
import type { NewsAnalyzer } from './company-analysis.ts';
import { runCompany } from './company-run.ts';
import { selectCompanies } from './company-selection.ts';
import { projectJobResult } from './job-projection.ts';
import { admitNewsEvent } from './news-admission.ts';
import { analyzeSegmentBatch } from './segment-analysis.ts';
import { buildSegments, refreshSegmentBatches } from './segment-policy.ts';

type Dependencies = {
  context: FlowContextClient;
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
    return this.enqueue(await admitNewsEvent(this.deps.context, raw));
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
    const { context, jobs, analyzer, reasoner } = this.deps;
    let job = initial;
    const request = flowRequestSchema.parse(job.request.parameters);
    const checkpoint = checkpointSchema.parse(job.checkpoint);
    // A retry keeps successful canonical writes and the plan, but failed work must be admitted again.
    if (checkpoint.companies.some((company) => company.status === 'failed')) {
      checkpoint.companies = checkpoint.companies.filter(
        (company) => company.status === 'completed',
      );
      checkpoint.roleViews = [];
    } else {
      checkpoint.roleViews = checkpoint.roleViews.filter(
        (view) =>
          typeof view === 'object' &&
          view !== null &&
          'status' in view &&
          view.status === 'completed',
      );
    }
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
      const news = await context.material(request.newsMaterialId, request.newsVersionId);
      if (news.kind !== 'news' || instantAfter(news.knownAt, request.asOf))
        throw new NewsAnalysisError(
          422,
          'INVALID_NEWS_TIME',
          'The triggering news must be known at asOf',
        );
      // Internal global news jobs start from public observations; restricted news uses the explicit company route.
      if (news.companyIds.length)
        throw new NewsAnalysisError(
          422,
          'RESTRICTED_NEWS',
          'A global news job requires a public news material',
        );
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
        for (const ref of [...refs.values()].slice(0, 8)) {
          const source = await context.material(ref.materialId, ref.versionId);
          if (
            source.kind !== 'market' ||
            source.companyIds.length ||
            source.contentHash !== ref.contentHash ||
            instantAfter(source.knownAt, request.asOf)
          )
            throw new NewsAnalysisError(
              502,
              'PUBLIC_SOURCE_SCOPE',
              'Public retrieval returned an unavailable source',
            );
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
        await selectCompanies(context, analyzer, request, checkpoint, plan);
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
      const profiles = new Map(
        (await context.companies(request.asOf)).map((p) => [p.companyId.toLowerCase(), p]),
      );
      if (!request.projectionOnly && reasoner.segments) {
        const segments = buildSegments(
          [...profiles.values()].filter((p) => selectedCompanyIds.includes(p.companyId)),
        );
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
              companyId,
              context,
              analyzer,
              reasoner,
              profiles,
              request,
              checkpoint,
              plan,
              news,
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
        context,
        analyzer,
        reasoner,
        request,
        checkpoint,
        plan,
        news,
        selectedCompanyIds,
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
