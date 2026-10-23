import { describe, expect, it } from 'vitest';
import {
  analysisRequestSchema,
  contextBundleSchema,
} from '../src/news-analysis/contracts/analysis.ts';
import { sameInstant, timestampSchema } from '../src/news-analysis/contracts/timestamps.ts';

describe('DateTimeOffset instant precision', () => {
  it('preserves 100ns and compares equivalent UTC/offset/fraction spellings', () => {
    expect(sameInstant('2026-10-21T07:20:00.0000001Z', '2026-10-21T07:20:00.0000002Z')).toBe(false);
    expect(sameInstant('2026-10-21T07:20:00.0000001Z', '2026-10-21T10:20:00.0000001+03:00')).toBe(
      true,
    );
    expect(sameInstant('2026-10-21T07:20:00.1Z', '2026-10-21T07:20:00.1000000+00:00')).toBe(true);
    expect(sameInstant('2024-03-01T00:00:00.0000001+03:00', '2024-02-29T21:00:00.0000001Z')).toBe(
      true,
    );
  });

  it('rejects unsupported precision and invalid calendar/range instants rather than truncating', () => {
    for (const value of [
      '2026-10-21T07:20:00.00000001Z',
      '2023-02-29T07:20:00Z',
      '2026-10-21T07:20:60Z',
      '2026-10-21T07:20:00+14:01',
      '0000-01-01T00:00:00Z',
      '0001-01-01T00:00:00+01:00',
    ])
      expect(timestampSchema.safeParse(value).success).toBe(false);
    expect(timestampSchema.safeParse('0001-01-01T00:00:00Z').success).toBe(true);
    expect(timestampSchema.safeParse('9999-12-31T23:59:59.9999999Z').success).toBe(true);
  });

  it('uses the same precision restriction for request and upstream context timestamps', () => {
    const asOf = '2026-10-21T07:20:00.00000001Z';
    expect(
      analysisRequestSchema.safeParse({
        companyId: '11111111-1111-4111-8111-111111111111',
        newsMaterialId: 'n',
        newsVersionId: 'v1',
        asOf,
      }).success,
    ).toBe(false);
    expect(contextBundleSchema.shape.coverage.shape.asOf.safeParse(asOf).success).toBe(false);
    expect(contextBundleSchema.shape.news.shape.knownAt.safeParse(asOf).success).toBe(false);
  });
});
