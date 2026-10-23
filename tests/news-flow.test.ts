import { expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { NewsFlow } from '../src/news-analysis/application/news-flow.ts';
import { projectRoleView } from '../src/news-analysis/application/role-projection.ts';
import { materialSchema } from '../src/news-analysis/contracts/analysis.ts';
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
import { InsightDomainClient } from '../src/news-analysis/retrieval/insight-domain-client.ts';

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
    if (path.endsWith('/material-versions/news/1')) return Response.json(news);
    if (path.endsWith('/search/sync')) return Response.json({});
    if (path.endsWith('/question-recipients'))
      return Response.json({ companyIds: [], nextCursor: null });
    if (path.endsWith('/knowledge/selection'))
      return Response.json({ groups: [], selectedCompanyIds: [companyId], pendingCompanyIds: [] });
    if (path.endsWith('/knowledge/companies')) return Response.json({ companies: [] });
    if (path.endsWith('/knowledge/role-scope'))
      return Response.json({ roles: [], missingPersonIds: [], companyIds: [companyId] });
    if (path.endsWith('/evidence'))
      return Response.json({
        companyId,
        asOf: time,
        completeForLoadedScope: true,
        changeSequence: 0,
        watchAfterSequence: 0,
        sources: [],
      });
    if (path.endsWith('/analyses/depth'))
      return Response.json({
        policyVersion: 'evidence-depth-v1',
        level: 'canonical_projection',
        reason: 'projection_refresh',
        ownOriginalCount: 0,
        inventoryCompleteForLoadedScope: true,
        sourceRefs: [],
        generalInsightIndexes: [],
        applicability: 'unknown',
        missingFacts: [],
      });
    if (path.endsWith('/analyses/canonical-company'))
      return Response.json({
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
      });
    if (path.endsWith('/changes')) return Response.json({ changes: [] });
    if (path.endsWith('/projections/canonical-facts'))
      return Response.json({ companies: JSON.parse(String(init?.body)).companies, facts: [] });
    if (path.endsWith('/projections/groups')) return Response.json({ groups: [] });
    throw new Error(`Unexpected API ${path}`);
  };
  const context = new FlowContextClient('http://context.test', 'secret', backend);
  const companies = new CompanyClient('http://companies.test', 'secret', backend);
  const jobs = new FlowJobClient('http://insights.test', 'secret', backend);
  const projections = new InsightDomainClient('http://insights.test', 'secret', backend);
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
    projections,
    analyzer,
    reasoner: { plan, role: vi.fn() },
  });
  await flow.tick();
  expect(job.status).toBe('completed');
  expect(job.checkpoint.selectedCompanyIds).toEqual([companyId]);
  expect(job.checkpoint.result).toMatchObject({ rankedCompanyFacts: [], groups: [], roles: [] });
  expect(plan).not.toHaveBeenCalled();
  expect(requests).toContain('/internal/knowledge/selection');
  expect(requests).toContain('/internal/analyses/depth');
  expect(requests).toContain('/internal/projections/canonical-facts');
  expect(requests).not.toContain('/internal/companies');
});

it('does not call the role model when Insight supplies no permitted facts', async () => {
  const profile = { personId: 'person', companyId, role: 'CFO', responsibilities: ['budget'] };
  const backend = vi.fn<typeof fetch>(async () =>
    Response.json({ profile, facts: [], groups: [] }),
  );
  const role = vi.fn();
  const view = await projectRoleView(
    new InsightDomainClient('http://insights.test', 'secret', backend),
    { role },
    {
      ...profile,
      revisionId: '1',
      allowedCompanyIds: [],
      allowedMaterialIds: [],
      knownAt: time,
      sourceRefs: [],
    },
    checkpointSchema.parse({}),
    request,
  );
  expect(view.status).toBe('withheld');
  expect(role).not.toHaveBeenCalled();
  expect(backend.mock.calls[0]?.[0]).toBe('http://insights.test/internal/projections/role');
});

it('sends group identities without repeating large membership payloads', async () => {
  const backend = vi.fn<typeof fetch>(async (_url, init) => {
    const body = String(init?.body);
    expect(body.length).toBeLessThan(15000);
    expect(JSON.parse(body).groups).toHaveLength(64);
    return Response.json({ groups: [] });
  });
  const groups = Array.from({ length: 64 }, (_, index) => ({
    groupId: `group-${index}`,
    companyIds: Array.from({ length: 512 }, () => companyId),
    paths: [],
    sourceRefs: [],
    missingGroups: [],
    cycles: [],
    complete: true,
  }));
  await new InsightDomainClient('http://insights.test', 'secret', backend).groups(groups, [], time);
});
