import { describe, expect, it } from 'vitest';
import {
  analysisWriteSchema,
  draftSchema,
  reasoningOutputSchema,
} from '../src/news-analysis/contracts/analysis.ts';

const source = { materialId: 'synthetic-news', versionId: 'v1', contentHash: 'a'.repeat(64) };
const draft = {
  effectKey: 'synthetic-effect',
  literalObjectRef: 'SYNTHETIC-LOT',
  conclusion: 'Synthetic forecast',
  status: 'forecast',
  sourceRefs: [source],
};
const request = {
  companyId: '11111111-1111-4111-8111-111111111111',
  newsMaterialId: 'synthetic-news',
  newsVersionId: 'v1',
  asOf: '2026-10-21T07:20:00Z',
};

describe('producer bounds from the InsightService contract', () => {
  it('accepts 32 drafts and rejects 33 for both model results and atomic writes', () => {
    for (const [count, accepted] of [
      [32, true],
      [33, false],
    ] as const) {
      const drafts = Array.from({ length: count }, (_, index) => ({
        ...draft,
        effectKey: `effect-${index}`,
      }));
      expect(reasoningOutputSchema.safeParse({ drafts }).success).toBe(accepted);
      expect(
        analysisWriteSchema.safeParse({
          ...request,
          drafts: drafts.map((item) => ({ ...item, expectedPreviousRevisionId: null })),
        }).success,
      ).toBe(accepted);
    }
  });

  it('accepts 64 source refs and rejects 65 before persistence', () => {
    for (const [count, accepted] of [
      [64, true],
      [65, false],
    ] as const) {
      const item = {
        ...draft,
        sourceRefs: Array.from({ length: count }, (_, index) => ({
          ...source,
          materialId: `source-${index}`,
        })),
      };
      expect(draftSchema.safeParse(item).success).toBe(accepted);
      expect(reasoningOutputSchema.safeParse({ drafts: [item] }).success).toBe(accepted);
      expect(
        analysisWriteSchema.safeParse({
          ...request,
          drafts: [{ ...item, expectedPreviousRevisionId: null }],
        }).success,
      ).toBe(accepted);
    }
  });

  it('keeps advertised string/calculation lexical bounds within the consumer bounds', () => {
    const calculation = {
      expression: { kind: 'value', value: '1' },
      unit: 'RUB',
      period: 'p'.repeat(1000),
    };
    expect(draftSchema.safeParse({ ...draft, status: 's'.repeat(100), calculation }).success).toBe(
      true,
    );
    expect(draftSchema.safeParse({ ...draft, status: 's'.repeat(101) }).success).toBe(false);
    expect(
      draftSchema.safeParse({ ...draft, calculation: { ...calculation, period: 'p'.repeat(1001) } })
        .success,
    ).toBe(false);
    for (const value of ['01', '1'.repeat(101)])
      expect(
        draftSchema.safeParse({
          ...draft,
          calculation: { ...calculation, expression: { kind: 'value', value } },
        }).success,
      ).toBe(false);
  });
});
