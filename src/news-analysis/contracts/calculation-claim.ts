import { z } from 'zod';
import { NewsAnalysisError } from './errors.ts';

export const calculationClaimSchema = z.strictObject({
  quote: z.string().min(1).max(200),
  value: z
    .string()
    .max(100)
    .regex(/^-?(0|[1-9]\d*)(\.\d+)?$/),
  unit: z.string().min(1).max(64),
  period: z.string().min(1).max(1000),
});

// Lexical binding only. Insight independently computes and verifies the result.
export function claimFromQuote(
  conclusion: string,
  quote: string | null | undefined,
  calculation: { unit: string; period: string } | undefined,
  title?: string | null,
) {
  if (quote == null) return undefined;
  const invalid = (code: string) =>
    new NewsAnalysisError(
      422,
      code,
      'Provide one exact decimal amount and currency span from title or conclusion, matching the explicit calculation unit and period; otherwise use qualitative narrative.',
    );
  if (!calculation) throw invalid('CONCLUSION_CLAIM_WITHOUT_CALCULATION');
  if (!quote || quote.length > 200) throw invalid('CONCLUSION_CLAIM_INVALID_QUOTE');
  const texts = (title == null ? [conclusion] : [conclusion, title]).filter((text) =>
    text.includes(quote),
  );
  if (!texts.length) throw invalid('CONCLUSION_CLAIM_INVALID_QUOTE');
  for (const text of texts) {
    const offset = text.indexOf(quote);
    const before = text.slice(0, offset).match(/.$/su)?.[0] ?? '';
    const after = text.slice(offset + quote.length).match(/^./su)?.[0] ?? '';
    if (
      text.indexOf(quote, offset + 1) >= 0 ||
      /[\p{L}\p{N}.,+−-]/u.test(before) ||
      /[\p{L}\p{N}]/u.test(after)
    )
      throw invalid('CONCLUSION_CLAIM_INVALID_QUOTE');
  }
  const match =
    /^([+-]?(?:[0-9]+|[0-9]{1,3}(?:[ \u00a0\u202f][0-9]{3})+)(?:\.[0-9]+)?)[ \u00a0\u202f]*([A-Z]{3}|₽|руб\.)$/u.exec(
      quote,
    );
  if (!match?.[1] || !match[2]) throw invalid('CONCLUSION_CLAIM_INVALID_QUOTE');
  const unit = match[2] === '₽' || match[2] === 'руб.' ? 'RUB' : match[2];
  if (unit !== calculation.unit) throw invalid('CONCLUSION_CLAIM_UNIT_MISMATCH');
  const token = match[1].replace(/[ \u00a0\u202f]/gu, '');
  const negative = token.startsWith('-');
  const [integer = '', fraction = ''] = token.replace(/^[+-]/u, '').split('.');
  const whole = integer.replace(/^0+(?=\d)/u, '');
  const decimal = fraction.replace(/0+$/u, '');
  const value = `${negative && (whole !== '0' || decimal) ? '-' : ''}${whole}${decimal ? `.${decimal}` : ''}`;
  if (value.length > 100) throw invalid('CONCLUSION_CLAIM_INVALID_QUOTE');
  return { quote, value, unit, period: calculation.period };
}

const conclusionCodes = new Set([
  'CONCLUSION_CLAIM_REQUIRED',
  'CONCLUSION_CLAIM_WITHOUT_CALCULATION',
  'CONCLUSION_CLAIM_INVALID_QUOTE',
  'CONCLUSION_CLAIM_VALUE_MISMATCH',
  'CONCLUSION_CLAIM_UNIT_MISMATCH',
  'CONCLUSION_CLAIM_PERIOD_MISMATCH',
  'CONCLUSION_UNBOUND_NUMBER',
]);
const titleCodes = new Set([
  'TITLE_REQUIRED',
  'TITLE_INVALID',
  'TITLE_NUMERIC_REQUIRES_CALCULATION',
]);

// Only agreed machine codes cross the model boundary; title suffixes may contain private data.
export function narrativeValidationError(errorTitle: string) {
  const code = errorTitle.split(/[:\s]/u, 1)[0];
  if (!code) return undefined;
  if (titleCodes.has(code))
    return {
      code,
      message:
        'Provide a short grounded qualitative title without opaque IDs. Without an explicit calculation avoid numbers, currency and scales. Preserve the narrative and unknowns.',
    };
  if (!conclusionCodes.has(code)) return undefined;
  return {
    code,
    message:
      'Title/conclusion claim rejected. Bind an exact decimal amount+currency quote to the calculation result, unit and period; otherwise use qualitative text without numbers. Preserve unknowns.',
  };
}
