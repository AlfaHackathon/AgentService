import { isDeepStrictEqual } from 'node:util';
import type { TranscriptContext } from '@earendil-works/pi-ai';

const newsResultTools = new Set([
  'submit_news_analysis',
  'plan_news_insights',
  'assess_evidence_relevance',
  'extract_source_signals',
  'review_source_signals',
  'project_role_actions',
]);
const separator = '\n\nReceived arguments:\n';
const maximumFeedbackBytes = 512;

// pi-ai repeats the complete invalid arguments in its generated schema error.
// Keep the actual assistant call and durable transcript intact; only remove this
// verified duplicate from the outbound model projection, never source/tool data.
export function compactNewsToolFeedback(context: TranscriptContext): TranscriptContext {
  const calls = new Map<string, { name: string; arguments: unknown }>();
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'toolCall') calls.set(part.id, part);
    }
    if (message.role !== 'toolResult' || !message.isError || !newsResultTools.has(message.toolName))
      return message;
    const call = calls.get(message.toolCallId);
    if (!call || call.name !== message.toolName) return message;
    const prefix = `Validation failed for tool "${message.toolName}":\n`;
    const content = message.content.map((part) => {
      if (part.type !== 'text' || !part.text.startsWith(prefix)) return part;
      const boundary = part.text.indexOf(separator, prefix.length);
      if (boundary < 0) return part;
      try {
        if (
          !isDeepStrictEqual(
            JSON.parse(part.text.slice(boundary + separator.length)),
            call.arguments,
          )
        )
          return part;
      } catch {
        return part;
      }
      const errors = part.text.slice(prefix.length, boundary).split('\n').filter(Boolean);
      const envelopeError =
        message.toolName === 'submit_news_analysis' && invalidCompanyEnvelope(call.arguments);
      // Union validators report several overlapping failures for the same path.
      // Keep one representative per path; the complete schema remains in tools.
      const paths = new Set<string>();
      const distinct = errors.filter((error) => {
        const path = error.slice(0, error.indexOf(':'));
        if (paths.has(path)) return false;
        paths.add(path);
        return true;
      });
      // A malformed envelope can produce many redundant root-field errors before
      // the actionable item failures. Keep each broken draft visible first.
      const prioritized =
        message.toolName === 'submit_news_analysis' ? prioritizeDraftIssues(distinct) : distinct;
      const issues = prioritized.slice(0, 8).map((issue) => {
        let bounded = '';
        for (const character of issue) {
          if (Buffer.byteLength(bounded + character, 'utf8') > 160) return `${bounded}…`;
          bounded += character;
        }
        return bounded;
      });
      const feedback = () =>
        JSON.stringify({
          status: 'invalid',
          code: 'TOOL_ARGUMENT_SCHEMA',
          tool: message.toolName,
          issues,
          issueCount: errors.length,
          detailsOmitted:
            errors.length > issues.length || errors.some((error, i) => error !== issues[i]),
          instruction: envelopeError
            ? 'Use {drafts:[{...}]}; every item must be an object. Put draft fields inside each item, never at top-level. Fix against the full schema; preserve evidence and unknowns.'
            : 'Fix against the full schema; preserve evidence and unknowns.',
        });
      while (issues.length && Buffer.byteLength(feedback(), 'utf8') > maximumFeedbackBytes)
        issues.pop();
      if (Buffer.byteLength(feedback(), 'utf8') > maximumFeedbackBytes) return part;
      changed = true;
      return { ...part, text: feedback() };
    });
    return { ...message, content };
  });
  return changed ? { ...context, messages } : context;
}

function prioritizeDraftIssues(issues: string[]) {
  const drafts = new Set<string>();
  const first: string[] = [];
  const remaining: string[] = [];
  for (const issue of issues) {
    const index = /^\s*-\s*(?:drafts\.(\d+)|\/drafts\/(\d+))(?:[.:/])/.exec(issue);
    const key = index?.[1] ?? index?.[2];
    if (key && !drafts.has(key)) {
      drafts.add(key);
      first.push(issue);
    } else remaining.push(issue);
  }
  return [...first, ...remaining];
}

// Structural guidance only: field requirements and values remain in the tool schema.
function invalidCompanyEnvelope(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  if (Object.keys(value).some((key) => key !== 'drafts')) return true;
  if (!('drafts' in value) || !Array.isArray(value.drafts)) return true;
  return value.drafts.some((draft) => !draft || typeof draft !== 'object' || Array.isArray(draft));
}
