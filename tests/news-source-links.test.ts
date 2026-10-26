import { expect, it } from 'vitest';
import { ExternalNewsClient } from '../src/news-analysis/retrieval/external-news.ts';

const dto = {
  source: 'Tass',
  externalId: 'publisher-123',
  title: 'Synthetic publisher announcement',
  text: 'Synthetic lead',
  publishedAt: '2026-10-24T12:00:00Z',
};
const asOf = '2026-10-25T00:00:00Z';
const client = (payload: unknown) =>
  new ExternalNewsClient('http://parser.test/news-parser-service', 'synthetic-only', async () =>
    Response.json(payload),
  );

it('preserves the explicit stored-news URL without promoting a lead to an original', async () => {
  const url = 'https://publisher.example.test/news/123?from=feed#original';
  const result = await client([{ ...dto, url }]).search('synthetic', 'stored', asOf);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    sourceUrl: url,
    textCompleteness: 'lead',
    originVersion: null,
  });
  expect(result.items[0]).not.toHaveProperty('url');
  expect(result.capabilities.fullText).toBe(false);
});

it.each([undefined, null])('preserves an honest null URL for legacy stored DTO %s', async (url) => {
  const result = await client([{ ...dto, url }]).search('synthetic', 'stored', asOf);
  expect(result.items[0]?.sourceUrl).toBeNull();
});

it.each(['stored', 'tass'] as const)('rejects unsafe URL in %s observations', async (channel) => {
  const item = { ...dto, lead: 'Synthetic lead', url: 'javascript:alert(1)' };
  await expect(client([item]).search('synthetic', channel, asOf)).rejects.toThrow();
});
