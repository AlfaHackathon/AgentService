import { afterEach, expect, it, vi } from 'vitest';
import { isTimeoutCause } from '../src/news-analysis/contracts/errors.ts';
import { ServiceClient } from '../src/news-analysis/transport/http/service-client.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('retries a timed-out read with a fresh deadline and preserves the exact body', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('gateway deadline', { status: 504 }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  const work = new ServiceClient('http://context.test', 'private', fetcher).request(
    '/internal/context/retrieve',
    { companyId: 'same', asOf: 'same' },
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(await work).toEqual({ ok: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1]?.body).toEqual(fetcher.mock.calls[1]?.[1]?.body);
  expect(fetcher.mock.calls[0]?.[1]?.signal).not.toBe(fetcher.mock.calls[1]?.[1]?.signal);
});

it('exhausts three attempts and never retries contract errors or unsafe CAS writes', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response('timeout', { status: 504 }));
  const client = new ServiceClient('http://insight.test', 'private', fetcher);
  const work = client
    .request('/internal/analyses', { same: 'immutable-payload' })
    .catch((error) => error);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await work).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockClear();
  expect(
    await client.request('/internal/news-jobs/id', { version: 1 }).catch((error) => error),
  ).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher
    .mockReset()
    .mockResolvedValue(
      Response.json({ code: 'invalid_context_budget', message: 'Invalid' }, { status: 422 }),
    );
  expect(
    await client.request('/internal/context/retrieve', {}).catch((error) => error),
  ).toMatchObject({ code: 'invalid_context_budget' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('classifies an early provider/runtime timeout through its cause without retrying arbitrary error prose', () => {
  expect(isTimeoutCause(new Error('agent failed', { cause: { type: 'submission_timeout' } }))).toBe(
    true,
  );
  expect(isTimeoutCause(new Error('provider', { cause: { status: 504 } }))).toBe(true);
  expect(isTimeoutCause(new DOMException('deadline', 'TimeoutError'))).toBe(true);
  expect(isTimeoutCause(new Error('timeout mentioned in a malformed response'))).toBe(false);
  expect(isTimeoutCause(new DOMException('cancelled', 'AbortError'))).toBe(false);
});
