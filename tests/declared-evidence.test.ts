import { describe, expect, it } from 'vitest';
import type { ContextBundle } from '../src/news-analysis/contracts/analysis.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { economicObjectCatalog } from '../src/news-analysis/retrieval/economic-objects.ts';
import { objectCatalog } from '../src/news-analysis/retrieval/source-catalog.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const asOf = '2026-10-26T10:00:00.0000001Z';
const source = (sourceId: string, materialId = sourceId): ContextBundle['news'] => ({
  materialId,
  sourceId,
  versionId: 'v1',
  contentHash: 'a'.repeat(64),
  kind: 'company',
  title: 'Synthetic source',
  text: 'loan FAKE-123 budget_baseline budget:2027',
  companyIds: [companyId],
  bankProfileIds: [],
  knownAt: asOf,
});
const excluded = [
  'company-bank-profile',
  'company-operational-declared-profile',
  'company-payment-activity',
  'company-payment-rows',
  'provided-bank-csv',
];
const request = { companyId, newsMaterialId: 'news', newsVersionId: 'v1', asOf };
const bundle = (): ContextBundle => ({
  news: { ...source('news-source', 'news'), kind: 'news', companyIds: [], text: 'Synthetic event' },
  materials: [
    source('company-bank-profile'),
    { ...source('trusted-payment-manifest'), text: 'raw data '.repeat(30000) },
    { ...source('uploaded-contract', 'real-contract'), text: 'loan REAL-789' },
  ],
  coverage: {
    asOf,
    complete: true,
    characters: 300000,
    materialCount: 4,
    companyMaterialCount: 3,
    marketMaterialCount: 0,
    previousNewsVersionCount: 0,
  },
});

describe('declared data is separated from documentary evidence', () => {
  it('cannot create contract/economic handles while preserving real source indices', () => {
    const sources = [
      ...excluded.map((id) => source(id)),
      { ...source('uploaded-contract'), text: 'loan REAL-789' },
    ];
    expect(objectCatalog(sources, companyId).map((entry) => entry.literal)).toEqual([
      `company:${companyId}`,
      'REAL-789',
    ]);
    const economics = economicObjectCatalog(sources, companyId, asOf);
    expect(economics.map((entry) => entry.economicObjectId)).toEqual(['REAL-789']);
    expect(economics[0]?.evidence[0]?.sourceHandle).toBe('s5');
  });

  it('drops raw duplicate profiles/payment tables but preserves excluded exact metadata and unknown coverage', async () => {
    const original = bundle();
    const client = new ContextClient(
      'http://context.test',
      'synthetic-key',
      async () => Response.json(original),
      ['trusted-payment-manifest'],
    );
    const context = await client.getContext(request);
    expect(context.materials.map((item) => item.materialId)).toEqual(['real-contract']);
    expect(JSON.stringify(context).length).toBeLessThan(4000);
    expect(context.nonDocumentarySources).toEqual(
      original.materials.slice(0, 2).map(({ materialId, versionId, contentHash, sourceId }) => ({
        materialId,
        versionId,
        contentHash,
        sourceId,
      })),
    );
    expect(context.coverage.complete).toBe(false);
    expect(context.coverage.companyMaterialCount).toBe(1);
    expect(context.coverage.materialCount).toBe(2);
    expect(original.materials).toHaveLength(3);
  });

  it('uses the same separation for follow-up retrieval without exposing a fake budget baseline', async () => {
    const client = new ContextClient(
      'http://context.test',
      'synthetic-key',
      async () => Response.json(bundle()),
      ['trusted-payment-manifest'],
    );
    const context = await client.followUp(request, ['synthetic query']);
    expect(context.materials).toHaveLength(1);
    expect(JSON.stringify(context)).not.toContain('FAKE-123');
    expect(context.nonDocumentarySources).toHaveLength(2);
  });

  it.each([
    { companyIds: ['22222222-2222-4222-8222-222222222222'] },
    { knownAt: '2026-10-26T10:00:00.0000002Z' },
    { companyIds: [] },
  ])('rejects invalid declared source scope before dropping raw text (%j)', async (defect) => {
    const invalid = { ...bundle(), materials: [{ ...source('company-bank-profile'), ...defect }] };
    const client = new ContextClient('http://context.test', 'synthetic-key', async () =>
      Response.json(invalid),
    );
    await expect(client.getContext(request)).rejects.toMatchObject({ code: 'UPSTREAM_CONTRACT' });
    await expect(client.followUp(request, ['synthetic query'])).rejects.toMatchObject({
      code: 'UPSTREAM_CONTRACT',
    });
  });
});
