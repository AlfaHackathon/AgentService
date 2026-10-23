import { z } from 'zod';
import { timestampSchema } from './timestamps.ts';

const field = (max: number) => z.string().trim().min(1).max(max);
const pascalEvent = z.strictObject({
  Source: field(200),
  ExternalId: field(1000),
  Title: field(1000),
  Text: z.string().max(200000),
  PublishedAt: timestampSchema,
});
const camelEvent = z.strictObject({
  source: field(200),
  externalId: field(1000),
  title: field(1000),
  text: z.string().max(200000),
  publishedAt: timestampSchema,
});

export function parseNewsKafkaEvent(value: Buffer | null) {
  if (!value || value.byteLength > 1048576) throw new Error('INVALID_EVENT');
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
  const event = z.union([pascalEvent, camelEvent]).parse(raw);
  const normalized =
    'Source' in event
      ? {
          source: event.Source,
          externalId: event.ExternalId,
          title: event.Title,
          text: event.Text,
          publishedAt: event.PublishedAt,
        }
      : event;
  // The current producer sends Subtitle/lead. There is no original URL/version
  // in this contract, and Kafka headers must never become model instructions.
  return { ...normalized, textCompleteness: 'lead' as const };
}
