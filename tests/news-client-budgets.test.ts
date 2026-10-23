import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';

const time = '2026-10-22T20:00:00Z';
const request = {
  companyId: '11111111-1111-4111-8111-111111111111',
  newsMaterialId: 'news',
  newsVersionId: 'v1',
  asOf: time,
};
const bundle = {
  news: {
    materialId: 'news',
    versionId: 'v1',
    sourceId: 'test',
    kind: 'news',
    title: 'News',
    text: 'Test source',
    knownAt: time,
    companyIds: [],
    bankProfileIds: [],
    contentHash: 'a'.repeat(64),
  },
  materials: [],
  coverage: {
    complete: true,
    materialCount: 1,
    companyMaterialCount: 0,
    marketMaterialCount: 0,
    previousNewsVersionCount: 0,
    characters: 100,
    asOf: time,
  },
};
function fetchAfter(ms: number): typeof fetch {
  return async (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      setTimeout(() => resolve(Response.json(bundle)), ms);
    });
}

describe('context HTTP operation budgets', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets multi-query retrieval finish after the ordinary 15-second request budget', async () => {
    const client = new ContextClient('http://context.test', 'test', fetchAfter(21000));
    const result = client
      .getContext({ ...request, retrievalQueries: ['query one', 'query two'] })
      .then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
    await vi.advanceTimersByTimeAsync(21000);
    expect((await result).value).toMatchObject(bundle);
  });

  it('bounds each multi-query retrieval attempt at 120 seconds and exhausts three attempts', async () => {
    const client = new ContextClient('http://context.test', 'test', fetchAfter(121000));
    const result = client.getContext({ ...request, retrievalQueries: ['query'] }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    await vi.advanceTimersByTimeAsync(363000);
    expect((await result).error).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });

  it('retains the 15-second budget for a plain stored context read', async () => {
    const client = new ContextClient('http://context.test', 'test', fetchAfter(21000));
    const result = client.getContext(request).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    await vi.advanceTimersByTimeAsync(48000);
    expect((await result).error).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });
});
