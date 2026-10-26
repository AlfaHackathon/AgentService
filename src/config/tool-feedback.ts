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
      // Union validators report several overlapping failures for the same path.
      // Keep one representative per path; the complete schema remains in tools.
      const paths = new Set<string>();
      const distinct = errors.filter((error) => {
        const path = error.slice(0, error.indexOf(':'));
        if (paths.has(path)) return false;
        paths.add(path);
        return true;
      });
      const issues = distinct.slice(0, 8).map((issue) => {
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
          instruction: 'Fix against the full schema; preserve evidence and unknowns.',
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
