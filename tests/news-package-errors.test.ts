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

it('delegates shallow applicability conflicts to Insight without parsing error prose', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ errorMessage: 'Canonical state changed' }, { status: 409 }),
  );
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
  ).rejects.toMatchObject({ status: 409, code: 'DEPTH_ESCALATION_REQUIRED' });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[0]).toBe('http://insight.test/internal/analyses/applicability');
});
