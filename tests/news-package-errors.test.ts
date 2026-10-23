import { expect, it, vi } from 'vitest';
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
