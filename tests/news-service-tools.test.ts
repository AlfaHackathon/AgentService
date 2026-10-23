import { describe, expect, it } from 'vitest';
import { ExternalNewsClient } from '../src/news-analysis/retrieval/external-news.ts';
import {
  admitCompanyBundle,
  initialToolState,
  type ToolScope,
} from '../src/news-analysis/retrieval/tool-evidence.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const asOf = '2026-10-22T08:00:00Z';
const news = {
  materialId: 'fixture-news',
  versionId: '1',
  contentHash: 'a'.repeat(64),
  sourceId: 'fixture',
  kind: 'news' as const,
  title: 'Public rate news',
  text: 'Public event',
  knownAt: asOf,
  companyIds: [],
  bankProfileIds: [],
};
const scope: Extract<ToolScope, { kind: 'company' }> = {
  kind: 'company',
  request: { companyId, newsMaterialId: news.materialId, newsVersionId: '1', asOf },
  context: {
    news,
    materials: [],
    coverage: {
      complete: false,
      asOf,
      characters: 100,
      materialCount: 1,
      companyMaterialCount: 0,
      marketMaterialCount: 0,
      previousNewsVersionCount: 0,
    },
  },
  objects: [],
};

describe('typed model service tools', () => {
  it('admits exact company originals, stops on no new evidence and rejects foreign/future sources', () => {
    const state = initialToolState(scope);
    const source = {
      ...news,
      materialId: 'fixture-company',
      kind: 'company' as const,
      companyIds: [companyId],
      contentHash: 'b'.repeat(64),
    };
    const found = { ...scope.context, materials: [source] };
    expect(admitCompanyBundle(scope, state, found).fresh).toEqual([source]);
    expect(admitCompanyBundle(scope, { ...state, sources: [news, source] }, found).stopReason).toBe(
      'no_new_evidence',
    );
    expect(() =>
      admitCompanyBundle(scope, state, {
        ...found,
        materials: [{ ...source, companyIds: ['22222222-2222-4222-8222-222222222222'] }],
      }),
    ).toThrow(/scope/);
    expect(() =>
      admitCompanyBundle(scope, state, {
        ...found,
        materials: [{ ...source, knownAt: '2026-10-22T08:00:00.0000001Z' }],
      }),
    ).toThrow(/scope/);
  });

  it('does not truncate a large original or admit it as complete evidence', () => {
    const found = {
      ...scope.context,
      materials: [{ ...news, materialId: 'large', text: 'x'.repeat(120001) }],
    };
    const admitted = admitCompanyBundle(scope, initialToolState(scope), found);
    expect(admitted.stopReason).toBe('context_budget');
    expect(admitted.sources).toEqual([news]);
    expect(admitted.fresh).toEqual([]);
  });

  it('preserves lead limitations, URL and observation hash without inventing a publisher version', async () => {
    let lead = 'Initial lead';
    const fetcher: typeof fetch = async (url, init) => {
      expect(String(url)).toContain('/news-parser-service/internal/news/tass-search?');
      expect(new Headers(init?.headers).get('X-Internal-Secret')).toBe('fixture-secret');
      return Response.json([
        {
          externalId: '123',
          title: 'Rate',
          lead,
          url: 'https://tass.ru/ekonomika/123',
          publishedAt: '2026-10-21T10:00:00Z',
        },
        {
          externalId: 'future',
          title: 'Future',
          lead: '',
          url: 'https://tass.ru/1',
          publishedAt: '2026-10-23T10:00:00Z',
        },
      ]);
    };
    const client = new ExternalNewsClient(
      'http://news.test/news-parser-service',
      'fixture-secret',
      fetcher,
    );
    const first = await client.search('ставка', 'tass', asOf);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      originVersion: null,
      textCompleteness: 'lead',
      sourceUrl: 'https://tass.ru/ekonomika/123',
    });
    expect(first.capabilities).toEqual({
      fullText: false,
      publisherVersions: false,
      corrections: false,
      alfaResearch: false,
    });
    expect((await client.search('ставка', 'tass', asOf)).items[0]?.observationHash).toBe(
      first.items[0]?.observationHash,
    );
    lead = 'Changed lead';
    expect((await client.search('ставка', 'tass', asOf)).items[0]?.observationHash).not.toBe(
      first.items[0]?.observationHash,
    );
  });

  it('reports empty observations and service failure without fabricated originals', async () => {
    const empty = new ExternalNewsClient('http://news.test', 'fixture', async () =>
      Response.json([]),
    );
    expect((await empty.search('absent', 'stored', asOf)).items).toEqual([]);
    const failed = new ExternalNewsClient(
      'http://news.test',
      'fixture',
      async () => new Response('', { status: 503 }),
    );
    await expect(failed.search('absent', 'tass', asOf)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});
