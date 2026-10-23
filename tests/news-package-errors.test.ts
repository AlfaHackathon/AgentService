import { expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';
import { ServiceClient } from '../src/news-analysis/transport/http/service-client.ts';

it.each([400, 409, 422, 503])('reads the package error envelope for HTTP %s', async (status) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ errorMessage: 'Package validation failed' }, { status }));
  await expect(
    new ServiceClient('http://insight.test', 'test-secret', fetcher).request(
      '/internal/analyses',
      {},
    ),
  ).rejects.toMatchObject({
    status: status === 503 ? 502 : status,
    code: 'UPSTREAM_ERROR',
    message: 'Package validation failed',
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  { nextVersion: 4, message: 'Different wording', expectedCode: 'DEPTH_ESCALATION_REQUIRED' },
  {
    nextVersion: 3,
    message: 'The immutable company snapshot changed before atomic commit.',
    expectedCode: 'UPSTREAM_ERROR',
  },
])(
  'checks state version after a shallow write conflict: $nextVersion',
  async ({ nextVersion, message, expectedCode }) => {
    let stateReads = 0;
    const writes: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/internal/effects') {
        return Response.json({ effects: [], stateVersion: ++stateReads === 1 ? 3 : nextVersion });
      }
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ errorMessage: message }, { status: 409 });
      }
      return Response.json({ errorMessage: 'Missing receipt' }, { status: 404 });
    });
    const analyzer = new NewsAnalyzer({
      context: new ContextClient('http://context.test', 'test-secret'),
      insights: new InsightClient('http://insight.test', 'test-secret', fetcher),
      reasoner: { analyze: vi.fn(async () => []) },
    });
    await expect(
      analyzer.recordApplicability({
        companyId: '11111111-1111-4111-8111-111111111111',
        newsMaterialId: 'news',
        newsVersionId: 'v1',
        asOf: '2026-10-23T10:00:00Z',
      }),
    ).rejects.toMatchObject({ status: 409, code: expectedCode });
    expect(stateReads).toBe(2);
    expect(writes).toEqual([expect.objectContaining({ expectedStateVersion: 3, drafts: [] })]);
  },
);
