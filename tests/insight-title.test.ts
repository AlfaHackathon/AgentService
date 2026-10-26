import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { analysisReceiptSchema, draftSchema } from '../src/news-analysis/contracts/analysis.ts';
import { claimFromQuote } from '../src/news-analysis/contracts/calculation-claim.ts';
import { resolveCompanyResult } from '../src/news-analysis/reasoning/company-result.ts';
import { newLoanQuestionResult, questionBindingScope } from './helpers/question-binding-replay.ts';

it('preserves a generated short qualitative title independently of the full conclusion', () => {
  const raw = newLoanQuestionResult();
  const title = '  Экспозиция требует проверки договора  ';
  const [draft] = resolveCompanyResult(
    { drafts: raw.drafts.map((value) => ({ ...value, title })) },
    questionBindingScope(),
  );
  expect(draft).toMatchObject({ title });
  expect(draft?.conclusion).not.toBe(title);
  expect(draftSchema.parse(draft)).toMatchObject({ title });
});

it('binds a numeric claim present only in the title without inventing a body quote', () => {
  const conclusion = 'Качественное описание последствий для компании.';
  expect(
    claimFromQuote(conclusion, '8 000 RUB', { unit: 'RUB', period: '2027' }, 'Расходы: 8 000 RUB'),
  ).toEqual({ quote: '8 000 RUB', value: '8000', unit: 'RUB', period: '2027' });
  expect(conclusion).not.toContain('8 000 RUB');
});

it('validates an exact shared literal independently in both title and conclusion', () => {
  expect(
    claimFromQuote(
      'Расходы: 8000 RUB за 2027 год.',
      '8000 RUB',
      { unit: 'RUB', period: '2027' },
      'Расходы: 8000 RUB',
    ),
  ).toMatchObject({ value: '8000' });
  expect(() =>
    claimFromQuote(
      'Расходы: 18000 RUB.',
      '8000 RUB',
      { unit: 'RUB', period: '2027' },
      'Расходы: 8000 RUB',
    ),
  ).toThrow(expect.objectContaining({ code: 'CONCLUSION_CLAIM_INVALID_QUOTE' }));
});

it('retains an internal diagnostic title without inventing a calculation or claim', () => {
  const raw = newLoanQuestionResult();
  const [draft] = resolveCompanyResult(
    { drafts: raw.drafts.map((value) => ({ ...value, title: 'Проверить заявленные 800 RUB' })) },
    questionBindingScope(),
  );
  expect(draft).toMatchObject({ title: 'Проверить заявленные 800 RUB' });
  expect(draft).not.toHaveProperty('calculation');
  expect(draft).not.toHaveProperty('calculationClaim');
});

it.each([undefined, null])(
  'keeps title %s compatible with legacy DTOs and no-insight drafts',
  (title) => {
    const raw = newLoanQuestionResult();
    const [draft] = resolveCompanyResult(
      {
        drafts: raw.drafts.map((value) => ({
          ...value,
          ...(title === undefined ? {} : { title }),
        })),
      },
      questionBindingScope(),
    );
    expect(draftSchema.parse(draft).title).toBe(title);
  },
);

it.each([' ', 'x'.repeat(181), 'Две\nстроки', 'Две\u2028строки', 'Две\u2029строки'])(
  'rejects invalid new title shape without truncating it: %s',
  (title) => {
    const raw = newLoanQuestionResult();
    expect(() =>
      resolveCompanyResult(
        { drafts: raw.drafts.map((value) => ({ ...value, title })) },
        questionBindingScope(),
      ),
    ).toThrow();
  },
);

it('rejects duplicate quote occurrences in either title or conclusion', () => {
  expect(() =>
    claimFromQuote(
      'Расходы: 8000 RUB.',
      '8000 RUB',
      { unit: 'RUB', period: '2027' },
      '8000 RUB и 8000 RUB',
    ),
  ).toThrow(expect.objectContaining({ code: 'CONCLUSION_CLAIM_INVALID_QUOTE' }));
  expect(() =>
    claimFromQuote(
      '8000 RUB и 8000 RUB.',
      '8000 RUB',
      { unit: 'RUB', period: '2027' },
      'Расходы: 8000 RUB',
    ),
  ).toThrow(expect.objectContaining({ code: 'CONCLUSION_CLAIM_INVALID_QUOTE' }));
});

it('reads legacy receipt titles as omitted/null and preserves an explicit revision title', () => {
  const legacy = analysisReceiptSchema.parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/insight-receipt-null-ast.json', import.meta.url), 'utf8'),
    ),
  );
  const effect = legacy.effects[0];
  if (!effect) throw new Error('Missing synthetic saved effect');
  expect(effect.currentRevision).not.toHaveProperty('title');
  for (const title of [null, 'Сохранённый самостоятельный заголовок']) {
    const decoded = analysisReceiptSchema.parse({
      ...legacy,
      effects: [{ ...effect, currentRevision: { ...effect.currentRevision, title } }],
    });
    expect(decoded.effects[0]?.currentRevision.title).toBe(title);
  }
});

it('retains no-insight diagnostics with an omitted title rather than manufacturing one', () => {
  const raw = newLoanQuestionResult();
  const drafts = resolveCompanyResult(raw, questionBindingScope());
  const request = questionBindingScope();
  const receipt = analysisReceiptSchema.parse({
    analysisId: 'internal-diagnostic',
    companyId: request.companyId,
    newsMaterialId: request.sources[0]?.materialId,
    newsVersionId: request.sources[0]?.versionId,
    asOf: request.asOf,
    completedAt: request.asOf,
    duplicate: false,
    resultSemantics: 'saved_analysis_revisions_not_latest_heads',
    effects: [],
    outcome: 'no_insight',
    unpublishedDrafts: drafts,
  });
  expect(receipt.effects).toEqual([]);
  expect(receipt.unpublishedDrafts?.[0]).not.toHaveProperty('title');
});
