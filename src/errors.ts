/**
 * Base client error (validation, timeout, transport).
 */
export class HavenError extends Error {
  readonly code?: string;
  override readonly cause?: unknown;

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message);
    this.name = "HavenError";
    this.code = opts?.code;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * HTTP error with Haven `{ error, message }` JSON body when present.
 */
export class HavenApiError extends HavenError {
  readonly status: number;
  readonly error: string;
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    body:
      { error?: string; message?: string; code?: string; retryAfterMs?: number } | string,
  ) {
    const normalized =
      typeof body === "string" ? { error: `http_${status}`, message: body } : body;
    super(normalized.message ?? normalized.error ?? `Haven API error ${status}`, {
      code: normalized.code,
    });
    this.name = "HavenApiError";
    this.status = status;
    this.error = normalized.error ?? `http_${status}`;
    this.retryAfterMs = normalized.retryAfterMs;
  }

  get unavailable(): boolean {
    return this.status === 503 || this.error === "DatabaseError";
  }

  get unauthorized(): boolean {
    return this.status === 401;
  }
}
