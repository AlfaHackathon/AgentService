import { describe, expect, it } from 'vitest';
import { CompanyClient } from '../src/news-analysis/retrieval/company-client.ts';
import { FlowContextClient, FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';
import { createHttpService } from './helpers/http-service.ts';

const time = '2026-10-23T10:00:00Z';
const cursor = { version: 0, sequence: 0, afterQuestion: null };
type Clients = {
  companies: CompanyClient;
  context: FlowContextClient;
  jobs: FlowJobClient;
  insights: InsightClient;
};
const requests: { name: string; invoke: (clients: Clients) => Promise<unknown> }[] = [
  { name: 'companies', invoke: ({ companies }) => companies.companies(time) },
  { name: 'groups', invoke: ({ companies }) => companies.groups(time) },
  { name: 'roles', invoke: ({ companies }) => companies.roleScope(time, [], []) },
  { name: 'search', invoke: ({ context }) => context.search('query', time) },
  { name: 'source changes', invoke: ({ context }) => context.changes(0) },
  { name: 'read cursor', invoke: ({ jobs }) => jobs.sourceCursor() },
  { name: 'advance cursor', invoke: ({ jobs }) => jobs.advanceSourceCursor(cursor) },
  { name: 'read job', invoke: ({ jobs }) => jobs.get('job') },
  { name: 'claim job', invoke: ({ jobs }) => jobs.claim('worker') },
  { name: 'recipients', invoke: ({ insights }) => insights.recipients(time) },
  {
    name: 'source reaction',
    invoke: ({ insights }) =>
      insights.react({
        sequence: 1,
        category: 'material:market',
        entityId: 'material',
        versionId: 'v1',
        knownAt: time,
        companyIds: [],
      }),
  },
];

describe('upstream response errors', () => {
  it.each(requests)(
    'classifies malformed $name responses as upstream contract failures',
    async ({ invoke }) => {
      const service = await createHttpService(() => Response.json({ unexpected: true }));
      try {
        await expect(
          invoke({
            companies: new CompanyClient(service.url, 'test-secret'),
            context: new FlowContextClient(service.url, 'test-secret'),
            jobs: new FlowJobClient(service.url, 'test-secret'),
            insights: new InsightClient(service.url, 'test-secret'),
          }),
        ).rejects.toMatchObject({ status: 502, code: 'UPSTREAM_CONTRACT' });
      } finally {
        await service.close();
      }
    },
  );

  it('preserves a null claim when no work is available', async () => {
    const service = await createHttpService(() => Response.json(null));
    try {
      expect(await new FlowJobClient(service.url, 'test-secret').claim('worker')).toBeNull();
    } finally {
      await service.close();
    }
  });
});
