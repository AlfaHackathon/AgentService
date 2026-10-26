import { NewsAnalysisError } from './errors.ts';

export const insightPlainTextCode = 'INSIGHT_PLAIN_TEXT_REQUIRED';
export const insightPlainTextMessage =
  'Use plain text for insight title and conclusion; keep source URLs in metadata.';

// Validate generated display text only. Originals, citations, assessments and
// legacy read DTOs retain their exact text; nothing is stripped or rewritten.
const markup =
  /\*\*|__|`|^[ \t]*~{3,}|^[ \t]*#{1,6}(?:[ \t]|\r?$)|!?\[[^\]\r\n]*\](?:\([^)\r\n]*\)|\[[^\]\r\n]*\])|https?:\/\//imu;
const italic =
  /(?:^|[ \t(])(?:\*[^*\s](?:[^*\r\n]*[^*\s])?\*|_[^_\s](?:[^_\r\n]*[^_\s])?_)(?=$|[ \t.,;:!?)]|\r?\n)/mu;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function validateInsightResultText(name: string, data: Record<string, unknown>): void {
  if (name !== 'submit_news_analysis' && name !== 'plan_news_insights') return;
  const plan = record(data.plan);
  for (const [key, entries] of [
    ['drafts', data.drafts],
    ['generalInsights', data.generalInsights],
    ['plan.generalInsights', plan?.generalInsights],
  ] as const) {
    if (!Array.isArray(entries)) continue;
    for (const [index, entry] of entries.entries()) {
      const fields = record(entry);
      for (const field of ['title', 'conclusion'] as const) {
        const text = fields?.[field];
        if (typeof text === 'string' && (markup.test(text) || italic.test(text)))
          throw new NewsAnalysisError(
            422,
            insightPlainTextCode,
            `${insightPlainTextCode}: ${key}[${index}].${field}`,
          );
      }
    }
  }
}
