import { NewsAnalysisError } from '../../contracts/errors.ts';

const messages = {
  INVALID_CONDITIONAL_EVIDENCE:
    'Conditional evidence requires an unresolved scenario on established exposure with explicit assumptions.',
  FINAL_CALCULATION_REQUIRED:
    'Final review retained a calculated question without its calculation. Return an explicit grounded calculation, an explicit unknown with structured missing facts, or withdraw the draft. The proposal is never copied automatically.',
};
type ValidationCode = keyof typeof messages;
const knownCode = (value: unknown): value is ValidationCode =>
  typeof value === 'string' && Object.hasOwn(messages, value);

export function validationOrigin(code: string) {
  return knownCode(code) ? { origin: 'company_validation' as const } : {};
}

export function conditionalRepair(code: string) {
  if (code !== 'INVALID_CONDITIONAL_EVIDENCE') return {};
  return {
    repair: {
      unknown: {
        status: 'unknown',
        evidenceStatus: 'unknown',
        calculation: 'Omit; do not copy the proposal or assert a computed amount in prose.',
        missingFact: 'Keep the actual missing fact in assessment.unknowns with its unique id.',
        dependentCondition: {
          assertion: 'derived',
          status: 'unknown',
          dependsOn: ['<missing-fact-id>'],
        },
        applicability:
          'Keep only documented exposure; never invent established exposure or assumptions. Remove scenario assumptions when declining to assess.',
      },
      scenario:
        'Use conditional only for an explicit scenario on documented established exposure, with assumptions and conditional conditions of status unknown. A retained calculated question still needs an explicit final calculation.',
      identity:
        'Preserve the literal object, business-question identity and exact citations. Do not equate different benchmarks or invent missing facts.',
    },
  };
}

// Only fixed, producer-generated domain errors survive result-budget exhaustion.
// Other tools and arbitrary SDK/service/source text keep the existing failure path.
export function exhaustedValidation(
  name: string,
  error: unknown,
  maximumSubmissions: number,
): string | undefined {
  if (name !== 'submit_news_analysis' || maximumSubmissions !== 2 || !(error instanceof Error))
    return;
  const code = validationCode(error.message);
  if (!code) return;
  return JSON.stringify({
    status: 'invalid',
    origin: 'company_validation',
    code,
    httpStatus: 422,
    message: messages[code],
    saved: false,
    maximumCorrections: 0,
    maximumSubmissions,
    exhausted: true,
  });
}

function validationCode(value: unknown): ValidationCode | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) return;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'status' in parsed &&
      parsed.status === 'invalid' &&
      'origin' in parsed &&
      parsed.origin === 'company_validation' &&
      'httpStatus' in parsed &&
      parsed.httpStatus === 422 &&
      'saved' in parsed &&
      parsed.saved === false &&
      'code' in parsed &&
      knownCode(parsed.code)
    )
      return parsed.code;
  } catch {
    /* Unknown formats are not a domain-error contract. */
  }
}

export function terminalValidation(value: unknown): NewsAnalysisError | undefined {
  const code = validationCode(value);
  if (!code || typeof value !== 'string') return;
  const parsed: unknown = JSON.parse(value);
  if (
    parsed &&
    typeof parsed === 'object' &&
    'exhausted' in parsed &&
    parsed.exhausted === true &&
    'maximumSubmissions' in parsed &&
    parsed.maximumSubmissions === 2 &&
    'maximumCorrections' in parsed &&
    parsed.maximumCorrections === 0
  )
    return new NewsAnalysisError(422, code, messages[code]);
}
