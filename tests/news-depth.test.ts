import { expect, it } from 'vitest';
import { chooseDepth } from '../src/news-analysis/application/depth-policy.ts';
import { flowRequestSchema } from '../src/news-analysis/contracts/flow.ts';

const companyId = '11111111-1111-4111-8111-111111111111',
  asOf = '2026-10-23T08:00:00Z';
const input = {
  companyId,
  request: flowRequestSchema.parse({ newsMaterialId: 'news', newsVersionId: '1', asOf }),
  plan: { eventSummary: 'Fixture', queries: ['Fixture'], generalInsights: [] },
  inventory: {
    companyId,
    asOf,
    completeForLoadedScope: true,
    changeSequence: 0,
    watchAfterSequence: 0,
    sources: [
      {
        materialId: 'profile',
        versionId: '1',
        contentHash: 'a'.repeat(64),
        sourceId: 'provided-bank-csv',
        knownAt: asOf,
      },
    ],
  },
  previous: [],
  hasProfile: true,
  newsCorrection: false,
};

it('selects general/applicability from loaded evidence, without declaring absence or exposure', () => {
  expect(chooseDepth(input)).toMatchObject({
    level: 'applicability',
    reason: 'profile_only',
    ownOriginalCount: 0,
    applicability: 'unknown',
  });
  expect(
    chooseDepth({ ...input, hasProfile: false, inventory: { ...input.inventory, sources: [] } }),
  ).toMatchObject({ level: 'general', reason: 'no_own_evidence', applicability: 'unknown' });
});
it('escalates an arbitrary own original, corrections and incomplete inventories instead of dropping them', () => {
  expect(
    chooseDepth({
      ...input,
      inventory: {
        ...input.inventory,
        sources: [
          {
            ...input.inventory.sources[0],
            materialId: 'own',
            versionId: '1',
            contentHash: 'a'.repeat(64),
            knownAt: asOf,
            sourceId: 'private-original',
          },
        ],
      },
    }),
  ).toMatchObject({ level: 'company_deep', reason: 'own_originals', applicability: 'unknown' });
  expect(chooseDepth({ ...input, newsCorrection: true }).level).toBe('company_deep');
  expect(
    chooseDepth({
      ...input,
      request: { ...input.request, trigger: { materialId: 'new-source', versionId: '1' } },
    }).level,
  ).toBe('company_deep');
  expect(
    chooseDepth({ ...input, inventory: { ...input.inventory, completeForLoadedScope: false } })
      .level,
  ).toBe('company_deep');
  expect(chooseDepth({ ...input, request: { ...input.request, projectionOnly: true } }).level).toBe(
    'canonical_projection',
  );
});
it('rejects foreign or future metadata before a shallow choice', () => {
  expect(() =>
    chooseDepth({
      ...input,
      inventory: { ...input.inventory, companyId: '22222222-2222-4222-8222-222222222222' },
    }),
  ).toThrow('inventory');
  expect(() =>
    chooseDepth({
      ...input,
      inventory: {
        ...input.inventory,
        sources: [
          {
            ...input.inventory.sources[0],
            materialId: 'future',
            versionId: '1',
            contentHash: 'b'.repeat(64),
            sourceId: 'private',
            knownAt: '2026-10-24T08:00:00Z',
          },
        ],
      },
    }),
  ).toThrow();
});

it('skips only explicitly unrelated complete evidence, and preserves unknown/correction escalation', () => {
  const profile = input.inventory.sources[0];
  if (!profile) throw new Error('Missing fixture profile');
  const own = { ...profile, sourceId: 'own', materialId: 'own' };
  const inventory = { ...input.inventory, sources: [own] };
  const relevance = [
    {
      sourceRef: {
        materialId: own.materialId,
        versionId: own.versionId,
        contentHash: own.contentHash,
      },
      status: 'unrelated' as const,
      reason: 'Unrelated historical administrative document; model routing assessment',
      quote: 'Administrative archive',
    },
  ];
  const assessment = relevance[0];
  if (!assessment) throw new Error('Missing fixture assessment');
  expect(chooseDepth({ ...input, inventory, relevance })).toMatchObject({
    level: 'applicability',
    reason: 'unrelated_evidence',
    applicability: 'unknown',
  });
  expect(
    chooseDepth({ ...input, inventory, relevance: [{ ...assessment, status: 'unknown' }] }).level,
  ).toBe('company_deep');
  expect(chooseDepth({ ...input, inventory, relevance, newsCorrection: true }).level).toBe(
    'company_deep',
  );
  expect(
    chooseDepth({ ...input, inventory: { ...inventory, completeForLoadedScope: false }, relevance })
      .level,
  ).toBe('company_deep');
});
