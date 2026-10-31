/**
 * Base class of every error this library throws, so `instanceof TechnogymError` catches them all.
 * `name` is the concrete subclass's name.
 */
export class TechnogymError extends Error {
  /** `options.cause` is the underlying error, if any. */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * Login failed, there is no session, or mywellness rejected the session token (HTTP 401/403 or an
 * auth-looking error in the response envelope). Sign in again.
 */
export class TechnogymAuthError extends TechnogymError {}

/** Network failure or timeout, after retries. */
export class TechnogymConnectionError extends TechnogymError {}

/** 429. `retryAfter` is seconds, taken from the Retry-After header when present. */
export class TechnogymRateLimitError extends TechnogymError {
  /** Thrown by the transport on a 429. */
  constructor(
    message: string,
    /** Seconds to wait before retrying, from the `Retry-After` header; absent without one. */
    readonly retryAfter?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Any other non-2xx response. */
export class TechnogymHttpError extends TechnogymError {
  /** Thrown by the transport for a non-2xx response that no other error class covers. */
  constructor(
    message: string,
    /** The HTTP status code. */
    readonly status: number,
    /** The URL that was requested, without its query string. */
    readonly url: string,
    /** The response body, as text. */
    readonly body: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** One entry of the `errors` array mywellness puts in a 200 response when a call fails. */
export interface MywellnessErrorEntry {
  /** Machine-readable reason, e.g. `ClientApplicationNotTrusted`. */
  details?: string;
  /** Human-readable message, when there is one. */
  errorMessage?: string;
  /** Alternative message field some endpoints use. */
  message?: string;
  [key: string]: unknown;
}

/**
 * mywellness answered 200 with a non-empty `errors` array that is not about the session. `errors`
 * is that array, untouched.
 */
export class TechnogymApiError extends TechnogymError {
  /** Thrown when a 200 response's envelope carries errors. */
  constructor(
    message: string,
    /** The endpoint's last path segment, e.g. `ActivityHistory`. */
    readonly action: string,
    /** The envelope's `errors` array. */
    readonly errors: readonly MywellnessErrorEntry[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The requested session, exercise or analytics record does not exist. */
export class TechnogymNotFoundError extends TechnogymError {}
