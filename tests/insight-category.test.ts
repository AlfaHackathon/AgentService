import * as v from 'valibot';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { draftSchema } from '../src/news-analysis/contracts/analysis.ts';
import { insightCategorySchema } from '../src/news-analysis/contracts/category.ts';
import { newsPlanSchema } from '../src/news-analysis/contracts/flow.ts';
import {
  nativeCategorySchema,
  planResultSchema,
  segmentResultSchema,
} from '../src/news-analysis/reasoning/agent-schemas.ts';

it.each(['risk', 'opportunity', 'event', null])(
  'accepts category %s independently of other dimensions',
  (category) => {
    expect(draftSchema.shape.category.parse(category)).toBe(category);
    expect(newsPlanSchema.shape.generalInsights.element.shape.category.parse(category)).toBe(
      category,
    );
    expect(v.parse(nativeCategorySchema, category)).toBe(category);
    expect(v.parse(planResultSchema.entries.generalInsights.item.entries.category, category)).toBe(
      category,
    );
    expect(
      v.parse(
        segmentResultSchema(['u0'], ['segment']).entries.generalInsights.item.entries.category,
        category,
      ),
    ).toBe(category);
  },
);
it.each(['unknown', 'mixed', 'Risk', '', 1, {}, undefined])(
  'rejects invalid or missing category %s in new structured model output',
  (category) => {
    expect(
      v.safeParse(planResultSchema.entries.generalInsights.item.entries.category, category).success,
    ).toBe(false);
    expect(v.safeParse(nativeCategorySchema, category).success).toBe(false);
  },
);
it('keeps legacy producer omission readable and the category enum exact', () => {
  expect(draftSchema.shape.category.parse(undefined)).toBeUndefined();
  expect(
    newsPlanSchema.shape.generalInsights.element.shape.category.parse(undefined),
  ).toBeUndefined();
  expect(z.toJSONSchema(insightCategorySchema).enum).toEqual(['risk', 'opportunity', 'event']);
});
