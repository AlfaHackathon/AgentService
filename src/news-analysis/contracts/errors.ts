export type AnalysisErrorStatus = 400 | 403 | 404 | 409 | 422 | 502 | 503;

export class NewsAnalysisError extends Error {
  readonly status: AnalysisErrorStatus;
  readonly code: string;

  constructor(status: AnalysisErrorStatus, code: string, message: string) {
    super(message);
    this.name = 'NewsAnalysisError';
    this.status = status;
    this.code = code;
  }
}

// Match typed machine-readable causes; error prose is not a retry contract.
export function isTimeoutCause(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error) || seen.size >= 8) return false;
  seen.add(error);
  if (
    ('name' in error && error.name === 'TimeoutError') ||
    ('type' in error && error.type === 'submission_timeout') ||
    ('status' in error && [408, 504].includes(Number(error.status))) ||
    ('code' in error &&
      [
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UPSTREAM_TIMEOUT',
      ].includes(String(error.code)))
  )
    return true;
  return 'cause' in error && isTimeoutCause(error.cause, seen);
}
