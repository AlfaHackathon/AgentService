import { z } from 'zod';
import { NewsAnalysisError } from '../../contracts/errors.ts';
import {
  type AdmittedNewsEvent,
  type ParserNewsReference,
  parserNewsReferenceSchema,
  parserSourceSchema,
} from '../../contracts/news-event.ts';
import { timestampSchema } from '../../contracts/timestamps.ts';
import { internalSecret, serviceUrl } from './settings.ts';

const responseSchema = z.object({
  source: parserSourceSchema,
  externalId: z.string().trim().min(1).max(1000),
  title: z.string().trim().min(1).max(1000),
  text: z.string().max(200000),
  publishedAt: timestampSchema,
});
const maximumBytes = 1048576;
const unavailable = () =>
  new NewsAnalysisError(
    502,
    'PARSER_NEWS_UNAVAILABLE',
    'Parser news read exceeded its bounded retry/time budget.',
  );
const invalid = () =>
  new NewsAnalysisError(
    422,
    'PARSER_NEWS_CONTRACT',
    'Parser news response does not match the required bounded contract.',
  );
async function boundedJson(response: Response) {
  if (Number(response.headers.get('content-length')) > maximumBytes) {
    await response.body?.cancel();
    throw invalid();
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw invalid();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalid();
  }
}

// Parser master f20738c: internal GET by Mongo ObjectId, not a publisher/material version.
// No arbitrary URL acquisition, model calls, process-wide deadlines or shared mutable state.
export class ParserNewsClient {
  readonly baseUrl: string;
  private readonly secret: string;
  constructor(
    url: string,
    secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = serviceUrl.parse(url).replace(/\/$/, '');
    this.secret = internalSecret.parse(secret);
  }
  async read(input: ParserNewsReference): Promise<AdmittedNewsEvent> {
    const reference = parserNewsReferenceSchema.parse(input);
    const deadline = Date.now() + 15000;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw unavailable();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(5000, remaining));
      try {
        const response = await this.fetcher(
          `${this.baseUrl}/internal/news/${reference.parserNewsId}`,
          {
            method: 'GET',
            headers: { 'X-Internal-Secret': this.secret, Accept: 'application/json' },
            redirect: 'error',
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403)
            throw new NewsAnalysisError(
              403,
              'PARSER_NEWS_ACCESS_DENIED',
              'Parser news read requires the configured internal service credential.',
            );
          if (response.status === 404)
            throw new NewsAnalysisError(
              422,
              'PARSER_NEWS_NOT_FOUND',
              'The referenced parser news document does not exist.',
            );
          if (response.status !== 408 && response.status !== 429 && response.status < 500)
            throw invalid();
          throw unavailable();
        }
        const parsed = responseSchema.safeParse(await boundedJson(response));
        if (!parsed.success) throw invalid();
        const news = parsed.data;
        if (news.source.toLowerCase() !== reference.source.toLowerCase())
          throw new NewsAnalysisError(
            422,
            'PARSER_NEWS_SOURCE_MISMATCH',
            'Parser document source does not match the Kafka reference.',
          );
        // Preserve broker source spelling to avoid silently changing existing admission IDs.
        // DTO has no completeness/version/URL guarantee. Extra fields do not promote this lead.
        return {
          source: reference.source,
          externalId: news.externalId,
          title: news.title,
          text: news.text,
          publishedAt: news.publishedAt,
          textCompleteness: 'lead',
        };
      } catch (error) {
        if (error instanceof NewsAnalysisError && error.status !== 502) throw error;
        if (attempt === 2 || deadline - Date.now() <= 250 * 2 ** attempt) throw unavailable();
      } finally {
        clearTimeout(timeout);
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw unavailable();
  }
}
