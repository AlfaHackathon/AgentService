import { expect, it } from 'vitest';
import { cachedInventory } from '../src/news-analysis/application/signal-cache.ts';
import {
  compactSignalPlan,
  normalizeSignalPlan,
  patchSignalCoverage,
} from '../src/news-analysis/reasoning/signal-plan.ts';
import {
  extractInventories,
  originalQuote,
  reviewInventories,
  signalBatches,
} from '../src/news-analysis/reasoning/source-signals.ts';

it('restores reflowed PDF whitespace without accepting changed numbers or OCR spelling', () => {
  expect(originalQuote('Demand\r\nrose 2% in May.', 'Demand rose 2% in May.')).toBe(
    'Demand\r\nrose 2% in May.',
  );
  expect(originalQuote('Demand rose 2% in May.', 'Demand rose 20% in May.')).toBeUndefined();
  expect(originalQuote('OCR 1126 forecast', 'OCR 1П26 forecast')).toBeUndefined();
});

it('bounds extraction packets without dropping, truncating or mixing original windows', () => {
  const units = Array.from({ length: 15 }, (_, i) => ({
    ...unit,
    unitId: `window-${i}`,
    text: 'x'.repeat(i < 5 ? 2400 : 120),
    sourceRef: { ...sourceRef, materialId: i < 9 ? 'first' : 'second' },
  }));
  const batches = signalBatches(units);
  expect(batches.flat()).toEqual(units);
  expect(batches.length).toBeGreaterThan(3);
  for (const batch of batches) {
    expect(batch.length).toBeLessThanOrEqual(6);
    expect(batch.reduce((n, u) => n + u.text.length, 0)).toBeLessThanOrEqual(4800);
    expect(new Set(batch.map((u) => u.sourceRef.materialId)).size).toBe(1);
  }
});

const sourceRef = {
  materialId: 'independent-fixture',
  versionId: '1',
  contentHash: 'b'.repeat(64),
};
const unit = {
  unitId: 'u1',
  sourceRef,
  start: 0,
  end: 68,
  text: 'Demand rose 2% in May. Staffing costs fell 3% in June.',
};
const signal = {
  kind: 'observation',
  statement: 'Demand increased',
  quote: 'Demand rose 2% in May.',
  period: 'May',
  scope: 'industry',
  mechanisms: ['demand'],
};
const data = {
  units: [
    {
      unitId: 'u1',
      disposition: 'signals',
      reason: 'Two independent changes',
      signals: [
        signal,
        {
          ...signal,
          statement: 'Staffing costs fell',
          quote: 'Staffing costs fell 3% in June.',
          period: 'June',
          mechanisms: ['labor_cost'],
        },
      ],
    },
  ],
};
it('retains two independent signals from one window with different host IDs', () => {
  const [inventory] = extractInventories(data, [unit]);
  expect(inventory?.signals).toHaveLength(2);
  expect(new Set(inventory?.signals.map((s) => s.signalId)).size).toBe(2);
  expect(inventory && cachedInventory(inventory, [unit])).toBe(true);
  expect(
    inventory &&
      cachedInventory(inventory, [{ ...unit, sourceRef: { ...sourceRef, versionId: '2' } }]),
  ).toBe(false);
});

it('keeps verified source signals unchanged and validates only explicit review replacements', () => {
  const draft = extractInventories(data, [unit]);
  const keep = {
    unitId: unit.unitId,
    action: 'keep',
    reason: 'Both changes checked independently',
    replacement: null,
  };
  expect(reviewInventories({ units: [keep] }, [unit], draft)[0]?.signals).toEqual(
    draft[0]?.signals,
  );
  expect(() => reviewInventories({ units: [] }, [unit], draft)).toThrow('every');
  expect(() =>
    reviewInventories(
      {
        units: [
          {
            ...keep,
            action: 'replace',
            replacement: {
              units: [
                { ...data.units[0], signals: [{ ...signal, quote: 'Demand rose 20% in May.' }] },
              ],
            },
          },
        ],
      },
      [unit],
      draft,
    ),
  ).toThrow('exact substring');
  const replacement = {
    ...data.units[0],
    signals: [{ ...signal, statement: 'Corrected observation with unchanged evidence' }],
  };
  const reviewed = reviewInventories(
    { units: [{ ...keep, action: 'replace', replacement: { units: [replacement] } }] },
    [unit],
    draft,
  );
  expect(reviewed[0]?.signals).toHaveLength(1);
  expect(reviewed[0]?.signals[0]?.statement).toBe(replacement.signals[0]?.statement);
});
it('rejects fabricated evidence, duplicated or omitted source windows', () => {
  expect(() => extractInventories({ units: [] }, [unit])).toThrow('each');
  expect(() => extractInventories({ units: [...data.units, ...data.units] }, [unit])).toThrow(
    'each',
  );
  expect(() =>
    extractInventories(
      { units: [{ ...data.units[0], signals: [{ ...signal, quote: 'Demand rose 20% in May.' }] }] },
      [unit],
    ),
  ).toThrow('exact substring');
});

it('does not let a used sibling signal hide an omitted or falsely used fact', () => {
  const inventories = extractInventories(data, [unit]);
  const signals = inventories.flatMap((i) => i.signals);
  const first = signals[0],
    second = signals[1];
  if (!first || !second) throw new Error('Missing fixture signals');
  const output = {
    eventSummary: 'Independent fixture',
    queries: [],
    signalCoverage: [
      { signalId: first.signalId, disposition: 'used', reason: 'Demand mechanism' },
      {
        signalId: second.signalId,
        disposition: 'background',
        reason: 'Staffing signal kept for later verification',
      },
    ],
    segmentCoverage: [{ segmentKey: 'activity:45.11', reason: 'Vehicle retail' }],
    generalInsights: [
      {
        title: 'Demand',
        conclusion: 'Demand rose in May; company volumes unknown',
        mechanism: 'demand',
        applicability: ['Vehicle retail exposure'],
        exclusions: [],
        unknowns: ['Company sales'],
        signalIds: [first.signalId],
        segmentKeys: ['activity:45.11'],
        quality: {
          decisionQuestion: 'Check volume assumptions?',
          distinctContribution: 'May observation',
          priority: 'medium',
          novelty: 'source_context',
        },
      },
    ],
  };
  const normalize = (o: unknown) =>
    normalizeSignalPlan(o, inventories, ['activity:45.11'], { ...sourceRef, materialId: 'news' });
  expect(normalize(output).signalCoverage?.[1]?.insightIndexes).toEqual([]);
  const { segmentCoverage: _coverage, queries: _queries, ...minimal } = output;
  expect(normalize(minimal).queries).toEqual([]);
  expect(normalize(minimal).segmentCoverage?.[0]).toMatchObject({
    segmentKey: 'activity:45.11',
    insightIndexes: [0],
  });
  expect(normalize(compactSignalPlan(normalize(output)))).toEqual(
    normalize({
      ...output,
      signalCoverage: output.signalCoverage.slice(1),
    }),
  );
  const incomplete = { ...output, signalCoverage: [] };
  const omitted = output.signalCoverage[1];
  if (!omitted) throw new Error('Missing fixture row');
  const repaired = patchSignalCoverage(incomplete, [omitted]);
  expect(repaired.generalInsights).toEqual(output.generalInsights);
  expect(normalize(repaired).signalCoverage).toHaveLength(2);
  expect(incomplete.signalCoverage).toEqual([]);
  expect(() => patchSignalCoverage(null, [])).toThrow('full plan');
  expect(
    normalize({ ...output, signalCoverage: output.signalCoverage.slice(1) }).signalCoverage?.[0],
  ).toMatchObject({ signalId: first.signalId, disposition: 'used', insightIndexes: [0] });
  expect(() => normalize({ ...output, signalCoverage: output.signalCoverage.slice(0, 1) })).toThrow(
    'every signal',
  );
  expect(
    normalize({
      ...output,
      signalCoverage: [
        output.signalCoverage[0],
        { ...output.signalCoverage[1], disposition: 'used' },
      ],
    }).signalCoverage?.[1],
  ).toMatchObject({
    disposition: 'background',
    insightIndexes: [],
    reason: expect.stringContaining('not covered by a sibling'),
  });
  expect(() =>
    normalize({
      ...output,
      generalInsights: [...output.generalInsights, ...output.generalInsights],
    }),
  ).toThrow('Duplicate');
  expect(() =>
    normalize({
      ...output,
      generalInsights: [{ ...output.generalInsights[0], segmentKeys: ['activity:45.31'] }],
    }),
  ).toThrow();
});
