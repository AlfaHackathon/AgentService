import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  analysisReceiptSchema,
  analysisWriteSchema,
  draftSchema,
  effectsResponseSchema,
} from '../src/news-analysis/contracts/analysis.ts';

// Exact persisted receipt from the failed real three-process run
// research/service-transfer-v1/runs/20261021T125402800800Z/InsightService.sqlite,
// analysis_receipts.payload_json. Terms and amounts are explicitly synthetic.
const wire = z
  .object({
    effects: z.tuple([
      z
        .object({
          currentRevision: z
            .object({
              calculation: z.object({
                expression: z.unknown(),
                unit: z.string(),
                period: z.string(),
              }),
            })
            .passthrough(),
        })
        .passthrough(),
    ]),
  })
  .passthrough()
  .parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/insight-receipt-null-ast.json', import.meta.url), 'utf8'),
    ),
  );
const saved = wire.effects[0];
const expectedExpression = {
  kind: 'multiply',
  left: {
    kind: 'subtract',
    left: { kind: 'value', value: '450' },
    right: { kind: 'value', value: '300' },
  },
  right: { kind: 'value', value: '104' },
};

function withExpression(expression: unknown) {
  return {
    ...wire,
    effects: [
      {
        ...saved,
        currentRevision: {
          ...saved.currentRevision,
          calculation: { ...saved.currentRevision.calculation, expression },
        },
      },
    ],
  };
}

describe('actual C# expression wire contract', () => {
  it('reads the real saved receipt and normalises inactive null fields only', () => {
    const receipt = analysisReceiptSchema.parse(wire);
    expect(receipt.effects[0]?.currentRevision.calculation?.expression).toEqual(expectedExpression);
    expect(receipt.effects[0]?.currentRevision.calculationResult).toBe('15600');
    expect(receipt.effects[0]?.currentRevision.calculationArithmeticOnly).toBe(true);
  });

  it('uses the same response normalisation for current effects and their history', () => {
    const result = effectsResponseSchema.parse({
      effects: [
        {
          effectId: saved.effectId,
          effectKey: 'LOT-104',
          companyId: wire.companyId,
          bankProfileId: wire.bankProfileId,
          newsMaterialId: wire.newsMaterialId,
          literalObjectRef: 'LOT-104',
          currentRevision: saved.currentRevision,
          history: [saved.currentRevision],
        },
      ],
    });
    expect(result.effects[0]?.currentRevision.calculation?.expression).toEqual(expectedExpression);
    expect(result.effects[0]?.history[0]?.calculation?.expression).toEqual(expectedExpression);
  });

  it('keeps model and write drafts strict against the C# wire-only null fields', () => {
    const draft = {
      effectKey: 'LOT-104',
      literalObjectRef: 'LOT-104',
      conclusion: 'Synthetic forecast',
      status: 'forecast',
      sourceRefs: saved.currentRevision.sourceRefs,
      calculation: saved.currentRevision.calculation,
    };
    expect(draftSchema.safeParse(draft).success).toBe(false);
    expect(
      analysisWriteSchema.safeParse({
        companyId: wire.companyId,
        bankProfileId: wire.bankProfileId,
        newsMaterialId: wire.newsMaterialId,
        newsVersionId: wire.newsVersionId,
        asOf: wire.asOf,
        drafts: [{ ...draft, expectedPreviousRevisionId: null }],
      }).success,
    ).toBe(false);
  });

  it('rejects inactive non-null values, unknown members and missing active operands', () => {
    for (const expression of [
      { ...expectedExpression, value: '999' },
      { ...expectedExpression, unexpected: null },
      { ...expectedExpression, left: null },
      {
        ...expectedExpression,
        right: { kind: 'value', value: '104', left: { kind: 'value', value: '1' }, right: null },
      },
    ])
      expect(analysisReceiptSchema.safeParse(withExpression(expression)).success).toBe(false);
  });
});
