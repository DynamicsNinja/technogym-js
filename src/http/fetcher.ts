import {
  TechnogymAuthError,
  TechnogymConnectionError,
  TechnogymHttpError,
  TechnogymRateLimitError,
} from "../errors.js";

const RETRY_STATUSES = new Set([408, 500, 502, 503, 504]);

/**
 * Methods safe to retry automatically. mywellness reads are POSTs, so `TechnogymClient` opts each
 * read in with `RequestOptions.retry`; the login POST is never retried.
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

export interface FetcherOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: string;
  json?: unknown;
  /**
   * Callers that must GUARANTEE a header wins (the bearer token) build a `Headers` and `.set()` it:
   * `Headers` is case-insensitive, object spread is not.
   */
  headers?: RequestInit["headers"];
  /** Per-request timeout, overriding the Fetcher's default. */
  timeoutMs?: number;
  /** Opt in to retrying a non-idempotent method (POST) on a retryable status or network error. */
  retry?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Fetcher {
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #backoffMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: FetcherOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#retries = options.retries ?? 3;
    this.#backoffMs = options.backoffMs ?? 500;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async request(url: string, options: RequestOptions = {}): Promise<Response> {
    const safeUrl = redactUrl(url);
    const headers = new Headers(options.headers ?? {});
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }

    const method = options.method ?? "GET";
    const canRetry = IDEMPOTENT_METHODS.has(method.toUpperCase()) || options.retry === true;
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      if (attempt > 0) await sleep(this.#backoffMs * 2 ** (attempt - 1));

      let res: Response;
      try {
        res = await this.#fetch(url, {
          method,
          headers,
          body,
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        lastError = cause;
        if (canRetry && attempt < this.#retries) continue;
        throw new TechnogymConnectionError(
          `Request to ${safeUrl} failed after ${attempt + 1} attempt${attempt === 0 ? "" : "s"}`,
          { cause: lastError },
        );
      }

      if (res.ok) return res;
      if (RETRY_STATUSES.has(res.status) && canRetry && attempt < this.#retries) continue;
      throw await toError(res, safeUrl);
    }

    throw new TechnogymConnectionError(`Request to ${safeUrl} failed after ${this.#retries + 1} attempts`, {
      cause: lastError,
    });
  }
}

async function toError(res: Response, safeUrl: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  if (res.status === 429) {
    const raw = res.headers.get("retry-after");
    const retryAfter = raw && !Number.isNaN(Number(raw)) ? Number(raw) : undefined;
    return new TechnogymRateLimitError(`Rate limited by mywellness at ${safeUrl}`, retryAfter);
  }
  if (res.status === 401 || res.status === 403) {
    return new TechnogymAuthError(`Not authorized for ${safeUrl} (${res.status})`);
  }
  return new TechnogymHttpError(`Request to ${safeUrl} failed with ${res.status}`, res.status, safeUrl, body);
}

/** Drops the query string, so an error message can never carry one. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}
