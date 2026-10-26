import { expect, it } from 'vitest';
import { draftSchema } from '../src/news-analysis/contracts/analysis.ts';
import { claimFromQuote } from '../src/news-analysis/contracts/calculation-claim.ts';
import { resolveCompanyResult } from '../src/news-analysis/reasoning/company-result.ts';
import { newLoanQuestionResult, questionBindingScope } from './helpers/question-binding-replay.ts';

function native(
  quote: string | null | undefined,
  conclusion = '  Расчётный эффект: -8 000.00 руб. за 2027 год.\n',
) {
  const raw = newLoanQuestionResult();
  return {
    drafts: raw.drafts.map((draft) => ({
      ...draft,
      conclusion,
      ...(quote !== undefined ? { calculationClaimQuote: quote } : {}),
      ...(quote ? { calculation: { expression: '-8000', unit: 'RUB', period: '2027' } } : {}),
    })),
  };
}

it('preserves narrative verbatim and binds the exact grouped signed amount without calculating it', () => {
  // Purely lexical claim construction; company financial policy is exercised separately.
  const base = draftSchema.parse({
    effectKey: 'fixture',
    literalObjectRef: 'fixture',
    conclusion: '  Unchanged narrative.\n',
    status: 'unknown',
    sourceRefs: [{ materialId: 'n', versionId: 'v1', contentHash: 'a'.repeat(64) }],
  });
  expect(base.conclusion).toBe('  Unchanged narrative.\n');
  const result = resolveCompanyResult(native(null), questionBindingScope());
  expect(result[0]?.conclusion).toBe('  Расчётный эффект: -8 000.00 руб. за 2027 год.\n');
});

it('does not invent a claim when the optional native quote is omitted', () => {
  const raw = newLoanQuestionResult();
  expect(resolveCompanyResult(raw, questionBindingScope())[0]).not.toHaveProperty(
    'calculationClaim',
  );
});

it.each([
  ['-8 000.00 руб.', '-8000', 'RUB'],
  ['+0008000.0100 RUB', '8000.01', 'RUB'],
  ['8 000 ₽', '8000', 'RUB'],
  ['8 000.50 RUB', '8000.5', 'RUB'],
  ['-0.000 RUB', '0', 'RUB'],
  ['800 EUR', '800', 'EUR'],
])('canonicalizes %s only lexically', (quote, value, unit) => {
  const conclusion = `  Собственный текст: ${quote}, период 2027.\n`;
  expect(claimFromQuote(conclusion, quote, { unit, period: '2027' })).toEqual({
    quote,
    value,
    unit,
    period: '2027',
  });
});

it.each([
  '8,000 RUB',
  '8e3 RUB',
  '8 тыс. руб.',
  'восемь тысяч рублей',
  '8 00 RUB',
  '800 RUB and 2 RUB',
])('rejects unsupported span %s without guessing or rewriting', (quote) => {
  expect(() => claimFromQuote(`Effect ${quote}.`, quote, { unit: 'RUB', period: '2027' })).toThrow(
    expect.objectContaining({ code: 'CONCLUSION_CLAIM_INVALID_QUOTE', status: 422 }),
  );
});

it.each(['1800 RUB', '-800 RUB', 'foo800 RUB', '800 RUBsuffix', '800 RUB; 800 RUB'])(
  'rejects partial or ambiguous bindings in %s',
  (conclusion) => {
    expect(() => claimFromQuote(conclusion, '800 RUB', { unit: 'RUB', period: '2027' })).toThrow(
      expect.objectContaining({ code: 'CONCLUSION_CLAIM_INVALID_QUOTE' }),
    );
  },
);

it('does not replace a quoted 800 with the separately computed result 8000', () => {
  expect(claimFromQuote('Effect: 800 RUB.', '800 RUB', { unit: 'RUB', period: '2027' })).toEqual({
    quote: '800 RUB',
    value: '800',
    unit: 'RUB',
    period: '2027',
  });
});

it('rejects a quote without calculation and a mismatched currency', () => {
  expect(() => claimFromQuote('Effect: 800 RUB.', '800 RUB', undefined)).toThrow(
    expect.objectContaining({ code: 'CONCLUSION_CLAIM_WITHOUT_CALCULATION', status: 422 }),
  );
  expect(() =>
    claimFromQuote('Effect: 800 EUR.', '800 EUR', { unit: 'RUB', period: '2027' }),
  ).toThrow(expect.objectContaining({ code: 'CONCLUSION_CLAIM_UNIT_MISMATCH', status: 422 }));
});

it.each([undefined, null])('does not invent a claim for quote %s', (quote) => {
  expect(
    claimFromQuote('Narrative is retained exactly.', quote, { unit: 'RUB', period: '2027' }),
  ).toBeUndefined();
});

it('rejects a supplied native quote without silently creating a calculation', () => {
  const raw = newLoanQuestionResult();
  const invalid = {
    drafts: raw.drafts.map((draft) => ({
      ...draft,
      conclusion: 'Effect: 800 RUB.',
      calculationClaimQuote: '800 RUB',
    })),
  };
  expect(() => resolveCompanyResult(invalid, questionBindingScope())).toThrow(
    expect.objectContaining({ status: 422, code: 'CONCLUSION_CLAIM_WITHOUT_CALCULATION' }),
  );
});

it('does not accept a partial amount embedded in a Unicode word', () => {
  for (const conclusion of ['𝔄800 RUB', '800 RUB𝟙'])
    expect(() => claimFromQuote(conclusion, '800 RUB', { unit: 'RUB', period: '2027' })).toThrow(
      expect.objectContaining({ code: 'CONCLUSION_CLAIM_INVALID_QUOTE' }),
    );
});

it('rejects whitespace-only conclusions without normalizing accepted narrative', () => {
  expect(draftSchema.shape.conclusion.safeParse(' \n\t ').success).toBe(false);
  const raw = newLoanQuestionResult();
  expect(() =>
    resolveCompanyResult(
      { drafts: raw.drafts.map((draft) => ({ ...draft, conclusion: ' \n ' })) },
      questionBindingScope(),
    ),
  ).toThrow();
});

it('rejects a control character in the quote while preserving it in the narrative', () => {
  const quote = '800 RUB\n';
  expect(() => claimFromQuote(`Effect: ${quote}`, quote, { unit: 'RUB', period: '2027' })).toThrow(
    expect.objectContaining({ code: 'CONCLUSION_CLAIM_INVALID_QUOTE', status: 422 }),
  );
});
