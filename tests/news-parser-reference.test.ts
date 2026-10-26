import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseNewsKafkaEvent } from '../src/news-analysis/contracts/news-event.ts';
import { ParserNewsClient } from '../src/news-analysis/transport/http/parser-news-client.ts';

const id = '0123456789abcdef01234567';
const reference = { source: 'Tass', parserNewsId: id };
const dto = {
  source: 'Tass',
  externalId: 'publisher-123',
  title: 'Synthetic news',
  text: '',
  publishedAt: '2026-10-25T00:00:00Z',
};
const legacy = {
  source: 'Tass',
  externalId: 'publisher-123',
  title: 'Synthetic news',
  text: '',
  publishedAt: dto.publishedAt,
  textCompleteness: 'lead',
};
const base = 'http://parser.test/news-parser-service';
afterEach(() => vi.useRealTimers());

describe('Kafka parser reference contract', () => {
  it('accepts Pascal/camel references and preserves source identity without treating Mongo ID as publisher ID', () => {
    expect(
      parseNewsKafkaEvent(Buffer.from(JSON.stringify({ Source: 'Tass', Id: id.toUpperCase() }))),
    ).toEqual(reference);
    expect(parseNewsKafkaEvent(Buffer.from(JSON.stringify({ source: 'Tass', id })))).toEqual(
      reference,
    );
  });
  it.each([
    '',
    '../private',
    'a'.repeat(23),
    'a'.repeat(25),
    'g'.repeat(24),
    'https://evil.test/news',
  ])('rejects malformed Mongo ID %s', (value) => {
    expect(() =>
      parseNewsKafkaEvent(Buffer.from(JSON.stringify({ Source: 'Tass', Id: value }))),
    ).toThrow();
  });
  it('rejects mixed/unknown source or injected routing fields', () => {
    for (const value of [
      { Source: 'other', Id: id },
      { Source: 'Tass', Id: id, ExternalId: 'spoofed' },
      { Source: 'Tass', id },
      { Source: 'Tass', Id: id, companyId: 'foreign' },
      { source: 'Tass', id, url: 'https://evil.test' },
    ])
      expect(() => parseNewsKafkaEvent(Buffer.from(JSON.stringify(value)))).toThrow();
  });
});

describe('bounded internal parser read', () => {
  it('reads only the configured internal route and yields the existing truthful lead admission contract', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...dto,
        textCompleteness: 'full',
        url: 'https://publisher.example.test/news/123',
        materialId: 'not-authoritative',
      }),
    );
    const result = await new ParserNewsClient(base, 'synthetic-secret', fetcher).read(reference);
    expect(result).toEqual({ ...legacy, sourceUrl: 'https://publisher.example.test/news/123' });
    expect(result).not.toHaveProperty('parserNewsId');
    expect(result.textCompleteness).toBe('lead');
    expect(fetcher).toHaveBeenCalledWith(
      `${base}/internal/news/${id}`,
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Internal-Secret': 'synthetic-secret', Accept: 'application/json' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each([undefined, null])(
    'keeps absent URL %s absent without deriving one from an ID',
    async (url) => {
      const result = await new ParserNewsClient(base, 'synthetic-secret', async () =>
        Response.json({ ...dto, url }),
      ).read(reference);
      expect(result).toEqual(legacy);
      expect(result).not.toHaveProperty('sourceUrl');
    },
  );
  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'file:///private',
    'ftp://publisher.example.test/news',
    'https://user:password@publisher.example.test/news',
    '/news/123',
    'https:publisher.example.test',
    ' https://publisher.example.test/news',
    'https://publisher.example.test/ne\nws',
    'https://publisher.example.test/a\\b',
  ])('rejects an unsafe owner URL %s without retry or admission', async (url) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...dto, url }));
    await expect(
      new ParserNewsClient(base, 'synthetic-secret', fetcher).read(reference),
    ).rejects.toMatchObject({ status: 422, code: 'PARSER_NEWS_CONTRACT' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('permits serializer case differences while retaining the event source spelling for stable admission identity', async () => {
    const result = await new ParserNewsClient(base, 'synthetic-secret', async () =>
      Response.json({ ...dto, source: 'tass' }),
    ).read(reference);
    expect(result.source).toBe('Tass');
  });
  it.each([
    { source: 'Alfa' },
    { externalId: '' },
    { title: '' },
    { publishedAt: 'invalid' },
    { text: 'x'.repeat(200001) },
  ])('rejects incompatible DTO without admitting it', async (change) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...dto, ...change }));
    await expect(
      new ParserNewsClient(base, 'synthetic-secret', fetcher).read(reference),
    ).rejects.toMatchObject({ status: 422 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 404, 400, 302])(
    'does not retry permanent response %s or leak response contents',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(async () => new Response('PRIVATE-UPSTREAM', { status }));
      await expect(
        new ParserNewsClient(base, 'synthetic-secret', fetcher).read(reference),
      ).rejects.toSatisfy(
        (error) => error instanceof Error && !error.message.includes('PRIVATE-UPSTREAM'),
      );
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it('retries transient status within its bounded attempt policy', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json(dto));
    const pending = new ParserNewsClient(base, 'synthetic-secret', fetcher).read(reference);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual(legacy);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('bounds repeated network errors to three attempts', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError('PRIVATE-NETWORK');
    });
    const pending = new ParserNewsClient(base, 'synthetic-secret', fetcher).read(reference);
    const assertion = expect(pending).rejects.toMatchObject({
      status: 502,
      code: 'PARSER_NEWS_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('bounds per-attempt and total time for aborting fetch dependencies', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Timeout', 'AbortError')),
            { once: true },
          ),
        ),
    );
    const pending = new ParserNewsClient(base, 'synthetic-secret', fetcher).read(reference);
    const assertion = expect(pending).rejects.toMatchObject({
      status: 502,
      code: 'PARSER_NEWS_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
  });
  it('rejects oversized streamed and invalid JSON bodies without retrying permanent contract errors', async () => {
    for (const response of [new Response('x'.repeat(1048577)), new Response('{')]) {
      const fetcher = vi.fn<typeof fetch>(async () => response);
      await expect(
        new ParserNewsClient(base, 'synthetic-secret', fetcher).read(reference),
      ).rejects.toMatchObject({ status: 422 });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('validates reference before any HTTP and does not permit credential-bearing URLs', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(dto));
    const client = new ParserNewsClient(base, 'synthetic-secret', fetcher);
    await expect(client.read({ ...reference, parserNewsId: '../escape' })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      () =>
        new ParserNewsClient(
          'https://user:password@parser.test/news-parser-service',
          'synthetic-secret',
        ),
    ).toThrow();
  });
});
