import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conclusionClaimError } from '../../contracts/calculation-claim.ts';
import { type AnalysisErrorStatus, NewsAnalysisError } from '../../contracts/errors.ts';
import { internalSecret, serviceUrl } from './settings.ts';

const upstreamErrorSchema = z.union([
  z.object({ code: z.string().max(200), message: z.string().max(2000) }),
  z.object({ errorMessage: z.string().max(2000) }).transform(({ errorMessage }) => ({
    code: 'UPSTREAM_ERROR',
    message: errorMessage,
  })),
]);

function publicUpstreamStatus(status: number): AnalysisErrorStatus {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 422:
      return status;
    default:
      return 502;
  }
}

export class ServiceClient {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetcher: typeof fetch;
  deadlineAt: number | undefined;

  constructor(baseUrl: string, secret: string, fetcher = fetch) {
    this.baseUrl = serviceUrl.parse(baseUrl).replace(/\/$/, '');
    this.secret = internalSecret.parse(secret);
    this.fetcher = fetcher;
  }

  async request(
    path: string,
    body?: unknown,
    allowNotFound = false,
    timeoutMs = 15000,
  ): Promise<unknown> {
    // These POSTs have deterministic identities or are pure reads. CAS lease/cursor
    // writes are deliberately excluded: retrying their version token is unsafe.
    const replayable =
      body === undefined ||
      new Set([
        '/internal/context',
        '/internal/context/retrieve',
        '/internal/search',
        '/internal/search/sync',
        '/internal/calculations/preview',
        '/internal/analyses',
        '/internal/analyses/session',
        '/internal/analyses/prepare',
        '/internal/execution/company-plan',
        '/internal/execution/company-watch',
        '/internal/execution/source-jobs',
        '/internal/projections/job',
        '/internal/news/admit',
        '/internal/news/resolve',
        '/internal/news/public-sources',
        '/internal/analyses/validate-applicability',
        '/internal/knowledge/selection',
        '/internal/knowledge/segments',
        '/internal/news-jobs',
      ]).has(path.split('?')[0] ?? path);
    const requestId = randomUUID();
    for (let attempt = 1; ; attempt++) {
      const remaining =
        this.deadlineAt === undefined
          ? timeoutMs
          : Math.min(timeoutMs, this.deadlineAt - Date.now());
      if (remaining <= 0)
        throw new NewsAnalysisError(
          502,
          'UPSTREAM_TIMEOUT',
          'The calling phase deadline is exhausted',
        );
      const signal = AbortSignal.timeout(remaining);
      let response: Response | undefined;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': this.secret },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
          redirect: 'error',
        });
        if (allowNotFound && response.status === 404) return null;
        const payload: unknown = await response.json();
        if (!response.ok) {
          const problem = upstreamErrorSchema.safeParse(payload);
          const conclusion = problem.success
            ? (conclusionClaimError(problem.data.code) ??
              conclusionClaimError(problem.data.message))
            : undefined;
          const unknownConclusion =
            problem.success &&
            !conclusion &&
            (problem.data.code.startsWith('CONCLUSION_') ||
              problem.data.message.startsWith('CONCLUSION_'));
          throw new NewsAnalysisError(
            publicUpstreamStatus(response.status),
            conclusion?.code ??
              (problem.success && !unknownConclusion ? problem.data.code : 'UPSTREAM_ERROR'),
            conclusion?.message ??
              (problem.success && !unknownConclusion
                ? problem.data.message
                : 'Upstream service rejected the request'),
          );
        }
        return payload;
      } catch (error) {
        const timedOut = signal.aborted || response?.status === 408 || response?.status === 504;
        if (
          timedOut &&
          replayable &&
          attempt < 3 &&
          (this.deadlineAt === undefined ||
            Date.now() + 1000 * 2 ** (attempt - 1) < this.deadlineAt)
        ) {
          const delayMs = 1000 * 2 ** (attempt - 1);
          console.warn(
            JSON.stringify({
              event: 'news.http_retry',
              requestId,
              path: path.split('?')[0],
              attempt,
              nextAttempt: attempt + 1,
              maximumAttempts: 3,
              delayMs,
              timeoutMs,
              code: 'UPSTREAM_TIMEOUT',
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        if (timedOut)
          throw new NewsAnalysisError(
            502,
            'UPSTREAM_TIMEOUT',
            'Upstream service exceeded its operation time budget',
          );
        if (error instanceof NewsAnalysisError) throw error;
        throw new NewsAnalysisError(502, 'UPSTREAM_UNAVAILABLE', 'Upstream service is unavailable');
      }
    }
  }
}

export function parseResponse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success)
    throw new NewsAnalysisError(502, 'UPSTREAM_CONTRACT', 'Upstream returned an invalid contract');
  return result.data;
}
