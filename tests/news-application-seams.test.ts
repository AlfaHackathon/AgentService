import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { runCompany } from '../src/news-analysis/application/company-run.ts';
import { admitNewsEvent } from '../src/news-analysis/application/news-admission.ts';
import { analysisReceiptSchema, materialSchema } from '../src/news-analysis/contracts/analysis.ts';
import { NewsAnalysisError } from '../src/news-analysis/contracts/errors.ts';
import {
  checkpointSchema,
  flowRequestSchema,
  jobSchema,
} from '../src/news-analysis/contracts/flow.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { FlowContextClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const time = '2026-10-23T08:00:00Z';
const publication = {
  source: 'publisher',
  externalId: 'release-1',
  title: 'Rate decision',
  text: 'Rate unchanged.',
  publishedAt: time,
  knownAt: time,
};
const notFound = () => new NewsAnalysisError(404, 'NOT_FOUND', 'Not found');
const materialInput = (raw: unknown) => z.record(z.string(), z.unknown()).parse(raw);

describe('news admission application boundary', () => {
  it('reuses the competing winner observation time after an immutable write conflict', async () => {
    const winnerTime = '2026-10-23T08:01:00Z';
    let winner: ReturnType<typeof materialSchema.parse> | undefined;
    const material = vi.fn(async () => {
      if (!winner) throw notFound();
      return winner;
    });
    const saveMaterial = vi.fn(async (raw: unknown) => {
      winner = materialSchema.parse({
        ...materialSchema.parse({ ...materialInput(raw), contentHash: 'a'.repeat(64) }),
        knownAt: winnerTime,
      });
      throw new NewsAnalysisError(409, 'VERSION_EXISTS', 'Concurrent admission won');
    });
    const request = await admitNewsEvent({ material, saveMaterial }, publication);
    expect(request.asOf).toBe(winnerTime);
    expect(request.textCompleteness).toBe('lead');
    expect(saveMaterial).toHaveBeenCalledTimes(1);
    const duplicate = await admitNewsEvent(
      { material, saveMaterial },
      { ...publication, knownAt: '2026-10-23T10:00:00Z' },
    );
    expect(duplicate).toEqual(request);
    expect(saveMaterial).toHaveBeenCalledTimes(1);
  });

  it('rejects a scoped stored original before a global job can be admitted', async () => {
    let saved: ReturnType<typeof materialSchema.parse> | undefined;
    const material = async () => {
      if (!saved) throw notFound();
      return saved;
    };
    const saveMaterial = async (raw: unknown) => {
      saved = materialSchema.parse({
        ...materialInput(raw),
        companyIds: [companyId],
        contentHash: 'a'.repeat(64),
      });
      return saved;
    };
    await expect(admitNewsEvent({ material, saveMaterial }, publication)).rejects.toMatchObject({
      code: 'NEWS_EVENT_CONFLICT',
    });
  });
});

it('persists the watch before the canonical receipt and retries catch-up without losing an event', async () => {
  const checkpoint = checkpointSchema.parse({});
  const request = flowRequestSchema.parse({
    newsMaterialId: 'news',
    newsVersionId: '1',
    asOf: time,
  });
  const news = materialSchema.parse({
    materialId: 'news',
    versionId: '1',
    sourceId: 'publisher',
    kind: 'news',
    title: 'Rate decision',
    text: 'Rate unchanged.',
    knownAt: time,
    companyIds: [],
    bankProfileIds: [],
    contentHash: 'a'.repeat(64),
  });
  const context = new FlowContextClient('http://context.test', 'test');
  const analyzer = new NewsAnalyzer({
    context: new ContextClient('http://context.test', 'test'),
    insights: new InsightClient('http://insights.test', 'test'),
    reasoner: { analyze: async () => [] },
  });
  vi.spyOn(analyzer, 'currentEffects').mockResolvedValue([]);
  vi.spyOn(context, 'evidence').mockResolvedValue({
    companyId,
    asOf: time,
    completeForLoadedScope: true,
    changeSequence: 10,
    watchAfterSequence: 10,
    sources: [],
  });
  vi.spyOn(context, 'changes').mockImplementation(async (after) =>
    after >= 11
      ? []
      : [
          {
            sequence: 11,
            category: 'material:company',
            entityId: 'contract',
            versionId: '2',
            knownAt: time,
            companyIds: [companyId],
          },
        ],
  );
  const order: string[] = [];
  const save = async () => {
    order.push(`save:${checkpoint.watchCursors[0]?.afterSequence}`);
  };
  vi.spyOn(analyzer, 'recordApplicability').mockImplementation(async () => {
    order.push('receipt');
    return {
      ...analysisReceiptSchema.parse({
        analysisId: 'analysis',
        companyId,
        newsMaterialId: 'news',
        newsVersionId: '1',
        asOf: time,
        completedAt: time,
        duplicate: false,
        resultSemantics: 'saved_analysis_revisions_not_latest_heads',
        effects: [],
      }),
      reasoningInvoked: false,
      contextComplete: false,
    };
  });
  const input = {
    companyId,
    context,
    analyzer,
    reasoner: { plan: async () => plan, role: async () => ({ actions: [], missingContext: [] }) },
    profiles: new Map(),
    request,
    checkpoint,
    plan: { eventSummary: 'Rate unchanged', queries: ['rate'], generalInsights: [] },
    news,
    save,
  };
  const plan = input.plan;
  await runCompany({
    ...input,
    enqueue: async () => {
      order.push('enqueue-failed');
      throw new Error('Offline');
    },
  });
  expect(order.slice(0, 3)).toEqual(['save:10', 'receipt', 'enqueue-failed']);
  expect(checkpoint.watchCursors[0]?.afterSequence).toBe(10);
  expect(checkpoint.companies[0]?.status).toBe('failed');
  checkpoint.companies = []; // Worker retries failed runs while retaining the durable watch.
  const enqueue = vi.fn(async () => {
    order.push('enqueue-success');
    return jobSchema.parse({
      request: { ...request, jobId: 'followup', parameters: request },
      status: 'queued',
      version: 1,
      workerId: null,
      leaseUntil: null,
      error: null,
      checkpoint: {},
      updatedAt: time,
    });
  });
  await runCompany({ ...input, enqueue });
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(checkpoint.watchCursors[0]).toMatchObject({
    afterSequence: 11,
    complete: true,
    followupJobIds: ['followup'],
  });
  expect(order.indexOf('enqueue-success')).toBeLessThan(order.indexOf('save:11'));
  expect(checkpoint.companies[0]).toMatchObject({ status: 'completed', contextComplete: false });
});
