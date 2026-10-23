import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { projectJobResult } from '../src/news-analysis/application/job-projection.ts';
import { NewsFlow } from '../src/news-analysis/application/news-flow.ts';
import { analysisReceiptSchema, materialSchema } from '../src/news-analysis/contracts/analysis.ts';
import {
  checkpointSchema,
  flowRequestSchema,
  jobSchema,
  type NewsJob,
} from '../src/news-analysis/contracts/flow.ts';
import { CompanyClient } from '../src/news-analysis/retrieval/company-client.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { FlowContextClient, FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const time = '2026-10-22T10:00:00Z';
const news = materialSchema.parse({
  materialId: 'news',
  versionId: '1',
  sourceId: 'synthetic',
  kind: 'news',
  title: 'Synthetic',
  text: 'Synthetic',
  knownAt: time,
  companyIds: [],
  bankProfileIds: [],
  contentHash: 'a'.repeat(64),
});
const request = flowRequestSchema.parse({
  newsMaterialId: 'news',
  newsVersionId: '1',
  asOf: time,
  projectionOnly: true,
});

it('uses Company selection and Insight projections while retaining the durable worker checkpoint', async () => {
  const requests: string[] = [];
  let job: NewsJob = jobSchema.parse({
    request: {
      jobId: 'synthetic',
      newsMaterialId: 'news',
      newsVersionId: '1',
      asOf: time,
      parameters: request,
    },
    status: 'running',
    version: 1,
    workerId: 'worker',
    leaseUntil: time,
    checkpoint: {},
    error: null,
    updatedAt: time,
  });
  const backend: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path.endsWith('/news-jobs/claim')) return Response.json(job);
    if (path.endsWith('/news-jobs/synthetic')) {
      const update = JSON.parse(String(init?.body));
      job = {
        ...job,
        ...update,
        checkpoint: structuredClone(update.checkpoint),
        version: job.version + 1,
      };
      return Response.json(job);
    }
    if (path.endsWith('/news/resolve')) return Response.json(news);
    if (path.endsWith('/search/sync')) return Response.json({});
    if (path.endsWith('/question-recipients'))
      return Response.json({ companyIds: [], nextCursor: null });
    if (path.endsWith('/knowledge/selection'))
      return Response.json({ groups: [], selectedCompanyIds: [companyId], pendingCompanyIds: [] });
    if (path.endsWith('/execution/company-plan')) {
      const registered = !!(job.checkpoint.watchCursors as unknown[] | undefined)?.length;
      return Response.json({
        analysisInput: { companyId, newsMaterialId: 'news', newsVersionId: '1', asOf: time },
        relevancePlan: { eventSummary: 'projection', queries: ['canonical'], generalInsights: [] },
        requiresWatchRegistration: !registered,
        watchAfterSequence: 0,
        relevanceSources: [],
        segmentKeys: [],
        depth: {
          policyVersion: 'evidence-depth-v1',
          level: 'canonical_projection',
          reason: 'projection_refresh',
          ownOriginalCount: 0,
          inventoryCompleteForLoadedScope: true,
          sourceRefs: [],
          generalInsightIndexes: [],
          applicability: 'unknown',
          missingFacts: [],
        },
        receipt: registered
          ? {
              analysisId: 'canonical',
              companyId,
              newsMaterialId: 'news',
              newsVersionId: '1',
              asOf: time,
              completedAt: time,
              duplicate: false,
              resultSemantics: 'saved_analysis_revisions_not_latest_heads',
              effects: [],
              contextComplete: true,
            }
          : null,
      });
    }
    if (path.endsWith('/execution/company-watch'))
      return Response.json({ requests: [], afterSequence: 0, complete: true });
    if (path.endsWith('/projections/job'))
      return Response.json({
        canonicalCompanies: job.checkpoint.companies,
        roleScopes: [],
        roleViews: [],
        result: { rankedCompanyFacts: [], groups: [], roles: [] },
      });
    throw new Error(`Unexpected API ${path}`);
  };
  const context = new FlowContextClient('http://context.test', 'secret', backend);
  const companies = new CompanyClient('http://companies.test', 'secret', backend);
  const jobs = new FlowJobClient('http://insights.test', 'secret', backend);
  const analyzer = new NewsAnalyzer({
    context: new ContextClient('http://context.test', 'secret', backend),
    insights: new InsightClient('http://insights.test', 'secret', backend),
    reasoner: { analyze: vi.fn() },
  });
  const plan = vi.fn();
  const flow = new NewsFlow({
    context,
    companies,
    jobs,
    analyzer,
    reasoner: { plan, role: vi.fn() },
  });
  await flow.tick();
  expect(job.status).toBe('completed');
  expect(job.checkpoint.selectedCompanyIds).toEqual([companyId]);
  expect(job.checkpoint.result).toMatchObject({ rankedCompanyFacts: [], groups: [], roles: [] });
  expect(plan).not.toHaveBeenCalled();
  expect(requests).toContain('/internal/knowledge/selection');
  expect(requests).toContain('/internal/execution/company-plan');
  expect(requests).toContain('/internal/projections/job');
  expect(requests).not.toContain('/internal/companies');
});

it('checkpoints a scoped model proposal before a failed projection submission', async () => {
  const receipt = analysisReceiptSchema.parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/insight-receipt-null-ast.json', import.meta.url), 'utf8'),
    ),
  );
  const effect = receipt.effects[0];
  if (!effect) throw new Error('Missing synthetic fixture effect');
  const jobs = new FlowJobClient('http://insights.test', 'secret');
  const projection = vi
    .spyOn(jobs, 'projection')
    .mockResolvedValueOnce({
      canonicalCompanies: [],
      roleViews: [],
      result: {},
      roleScopes: [
        {
          key: 'role-1',
          scopeVersion: 'opaque-snapshot',
          profile: { personId: 'person', companyId, role: 'CFO', responsibilities: [] },
          facts: [
            {
              companyId,
              effectId: effect.effectId,
              revision: effect.currentRevision,
              priority: 0,
              requiresReassessment: false,
            },
          ],
          groups: [],
        },
      ],
    })
    .mockRejectedValueOnce(new Error('Submission unavailable'));
  const checkpoint = checkpointSchema.parse({});
  const saved: unknown[] = [];
  await expect(
    projectJobResult({
      jobId: 'job',
      jobs,
      checkpoint,
      asOf: time,
      reasoner: { plan: vi.fn(), role: async () => ({ actions: [], missingContext: [] }) },
      ensureLease: () => {},
      save: async () => {
        saved.push(structuredClone(checkpoint.roleViews));
      },
    }),
  ).rejects.toThrow('Submission unavailable');
  expect(saved.at(-1)).toEqual([
    {
      actions: [],
      missingContext: [],
      key: 'role-1',
      scopeVersion: 'opaque-snapshot',
      status: 'proposed',
    },
  ]);
  expect(projection.mock.calls[1]?.[2]).toEqual(saved.at(-1));
});
