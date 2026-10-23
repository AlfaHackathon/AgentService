import { expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { runCompany } from '../src/news-analysis/application/company-run.ts';
import { analysisReceiptSchema, materialSchema } from '../src/news-analysis/contracts/analysis.ts';
import {
  checkpointSchema,
  flowRequestSchema,
  jobSchema,
} from '../src/news-analysis/contracts/flow.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const companyId = '11111111-1111-4111-8111-111111111111',
  time = '2026-10-23T08:00:00Z';
it('registers the watch before receipt acquisition and advances it only after durable enqueue', async () => {
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
    title: 'synthetic',
    text: 'synthetic',
    knownAt: time,
    companyIds: [],
    bankProfileIds: [],
    contentHash: 'a'.repeat(64),
  });
  const jobs = new FlowJobClient('http://insights.test', 'secret');
  const analyzer = new NewsAnalyzer({
    context: new ContextClient('http://context.test', 'secret'),
    insights: new InsightClient('http://insights.test', 'secret'),
    reasoner: { analyze: async () => [] },
  });
  const order: string[] = [];
  const plan = { eventSummary: 'synthetic', queries: ['synthetic'], generalInsights: [] };
  vi.spyOn(jobs, 'companyPlan').mockImplementation(async () => {
    const registered = checkpoint.watchCursors.length > 0;
    order.push(registered ? 'receipt' : 'prepare');
    return {
      analysisInput: { companyId, ...request },
      relevancePlan: plan,
      requiresWatchRegistration: !registered,
      watchAfterSequence: 10,
      relevanceSources: [],
      segmentKeys: [],
      depth: {
        policyVersion: 'evidence-depth-v1',
        level: 'general',
        reason: 'no_own_evidence',
        ownOriginalCount: 0,
        inventoryCompleteForLoadedScope: true,
        sourceRefs: [],
        generalInsightIndexes: [],
        applicability: 'unknown',
        missingFacts: [],
      },
      receipt: registered
        ? analysisReceiptSchema.parse({
            analysisId: 'analysis',
            companyId,
            ...request,
            completedAt: time,
            duplicate: false,
            resultSemantics: 'saved_analysis_revisions_not_latest_heads',
            effects: [],
          })
        : null,
    };
  });
  vi.spyOn(jobs, 'companyWatch').mockResolvedValue({
    requests: [request],
    afterSequence: 11,
    complete: true,
  });
  const input = {
    jobId: 'job',
    companyId,
    news,
    jobs,
    analyzer,
    reasoner: { plan: async () => plan, role: async () => ({ actions: [], missingContext: [] }) },
    checkpoint,
    save: async () => {
      order.push(`save:${checkpoint.watchCursors[0]?.afterSequence}`);
    },
  };
  await runCompany({
    ...input,
    enqueue: async () => {
      order.push('enqueue-failed');
      throw new Error('offline');
    },
  });
  expect(order.slice(0, 4)).toEqual(['prepare', 'save:10', 'receipt', 'enqueue-failed']);
  expect(checkpoint.watchCursors[0]?.afterSequence).toBe(10);
  checkpoint.companies = [];
  await runCompany({
    ...input,
    enqueue: async () => {
      order.push('enqueue-success');
      return jobSchema.parse({
        request: { jobId: 'followup', ...request, parameters: request },
        status: 'queued',
        version: 1,
        workerId: null,
        leaseUntil: null,
        error: null,
        checkpoint: {},
        updatedAt: time,
      });
    },
  });
  expect(order.indexOf('enqueue-success')).toBeLessThan(order.indexOf('save:11'));
  expect(checkpoint.watchCursors[0]).toMatchObject({
    afterSequence: 11,
    complete: true,
    followupJobIds: ['followup'],
  });
});
