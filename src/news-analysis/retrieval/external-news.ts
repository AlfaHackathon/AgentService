import { createHash } from 'node:crypto';
import { z } from 'zod';
import { instantAfter, timestampSchema } from '../contracts/timestamps.ts';
import { ServiceClient } from '../transport/http/service-client.ts';

const stored = z.object({
  source: z.string(),
  externalId: z.string(),
  title: z.string(),
  text: z.string(),
  publishedAt: timestampSchema,
});
const tass = z.object({
  externalId: z.string(),
  title: z.string(),
  lead: z.string().nullable(),
  url: z.url(),
  publishedAt: timestampSchema,
});

// Verified against WebNewsParserService 558025d. These APIs return leads, not originals.
// The hash identifies this retrieved observation only; it is NOT a publisher version.
export class ExternalNewsClient {
  readonly http: ServiceClient;
  constructor(url: string, secret: string, fetcher = fetch) {
    this.http = new ServiceClient(url, secret, fetcher);
  }
  async search(query: string, channel: 'stored' | 'tass', asOf: string) {
    const path = channel === 'tass' ? 'tass-search' : 'search';
    const payload = await this.http.request(
      `/internal/news/${path}?${new URLSearchParams({ search: query, limit: '6' })}`,
    );
    const observedAt = new Date().toISOString();
    const items =
      channel === 'tass'
        ? z
            .array(tass)
            .max(20)
            .parse(payload)
            .map((i) => ({
              source: 'tass',
              externalId: i.externalId,
              title: i.title,
              text: i.lead ?? '',
              sourceUrl: i.url,
              publishedAt: i.publishedAt,
            }))
        : z
            .array(stored)
            .max(100)
            .parse(payload)
            .map((i) => ({ ...i, sourceUrl: null }));
    return {
      status: 'lead_observations' as const,
      observedAt,
      asOf,
      capabilities: {
        fullText: false,
        publisherVersions: false,
        corrections: false,
        alfaResearch: false,
      },
      limitation:
        'Lead only. Publisher version and original retrieval time are unavailable. Observations are discovery candidates, not citable historical originals; load an exact permitted material before using it as evidence.',
      items: items
        .filter((i) => !instantAfter(i.publishedAt, asOf))
        .slice(0, 6)
        .map((i) => ({
          ...i,
          textCompleteness: 'lead' as const,
          originVersion: null,
          observationHash: createHash('sha256').update(JSON.stringify(i)).digest('hex'),
        })),
    };
  }
}
