import { appHeaders, CORE_URL, LOGIN_PATH, SERVICES_URL } from "./auth/constants.js";
import { MemorySessionStore, type Session, type SessionStore } from "./auth/session-store.js";
import {
  TechnogymApiError,
  TechnogymAuthError,
  TechnogymError,
  type MywellnessErrorEntry,
} from "./errors.js";
import { Fetcher } from "./http/fetcher.js";
import { parseUser } from "./parse.js";
import type { Facility, UserInfo } from "./types.js";

/** An email and password for mywellness. */
export interface Credentials {
  email: string;
  password: string;
}

/** Options for `new TechnogymClient(...)`. Every field is optional. */
export interface TechnogymClientOptions {
  /** Where the session is loaded from and saved to. Default: a `MemorySessionStore`. */
  sessionStore?: SessionStore;
  /**
   * Sign in lazily on the first call and again whenever mywellness rejects the token. Without
   * them, call `login` or `loadSession` first, and a rejected token throws `TechnogymAuthError`.
   * Credentials passed to `login()` are also kept (in memory only) for the same purpose.
   */
  credentials?: Credentials;
  /**
   * Which facility's url prefixes training paths, matched against a facility's `id` or `url`.
   * Default: the account's first facility.
   */
  facility?: string;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** How many times a transient failure of a read is retried. Default 3. */
  retries?: number;
  /** Delay before the first retry in ms, doubled on each retry after it. Default 500. */
  backoffMs?: number;
  /** A `fetch` to use instead of the global one, e.g. a mock in tests. */
  fetchImpl?: typeof fetch;
}

/** Options for one raw `services` call. */
export interface ServiceOptions {
  /** Per-request timeout, overriding the client's default. */
  timeoutMs?: number;
  /**
   * Retry on a 5xx or network error. Default `true`: every mywellness read is a POST, and this
   * library only reads. Pass `false` for a POST that changes something.
   */
  retry?: boolean;
}

/** mywellness `details` values that mean "the session is gone", not "the call is wrong". */
const AUTH_ERROR_DETAILS = new Set([
  "TokenNotValid",
  "InvalidToken",
  "TokenExpired",
  "NotAuthenticated",
  "Unauthorized",
  "UserNotLogged",
]);

/** Whether an envelope's `errors` describe a rejected session. */
export function isAuthErrorEntry(errors: readonly MywellnessErrorEntry[]): boolean {
  return errors.some((e) => {
    const details = String(e.details ?? e.message ?? "");
    return AUTH_ERROR_DETAILS.has(details) || details.toLowerCase().includes("token");
  });
}

function errorsText(errors: readonly MywellnessErrorEntry[]): string {
  return errors.map((e) => String(e.errorMessage ?? e.message ?? e.details ?? JSON.stringify(e))).join("; ");
}

interface Envelope {
  data?: unknown;
  errors?: MywellnessErrorEntry[];
  token?: unknown;
  [key: string]: unknown;
}

/**
 * The authenticated HTTP transport: signs in to mywellness, keeps the session, and sends
 * requests to `services.mywellness.com/{facility}`. Wrap it in a `Technogym` to call the API.
 */
export class TechnogymClient {
  /** Where this client loads and saves its session. */
  readonly sessionStore: SessionStore;

  readonly #fetcher: Fetcher;
  readonly #facility: string | undefined;
  #credentials: Credentials | undefined;
  #session: Session | null = null;
  #signingIn: Promise<Session> | null = null;

  /** Creates a client that is not signed in yet. */
  constructor(options: TechnogymClientOptions = {}) {
    this.sessionStore = options.sessionStore ?? new MemorySessionStore();
    this.#credentials = options.credentials;
    this.#facility = options.facility;
    this.#fetcher = new Fetcher({
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      backoffMs: options.backoffMs,
      fetchImpl: options.fetchImpl,
    });
  }

  /**
   * Signs in with email and password and saves the session to the store. The credentials are
   * kept in memory so a rejected token can be renewed without asking again. Throws
   * `TechnogymAuthError` when mywellness refuses them.
   */
  async login(email: string, password: string): Promise<Session> {
    this.#credentials = { email, password };
    return this.#signIn();
  }

  /** Loads the saved session. Returns false when the store holds none. */
  async loadSession(): Promise<boolean> {
    const session = await this.sessionStore.load();
    if (!session) return false;
    this.#session = session;
    return true;
  }

  /** Uses this session from now on. Does not save it to the store. */
  setSession(session: Session): void {
    this.#session = session;
  }

  /** The session currently held in memory, or `null` before a login or `loadSession()`. */
  getSession(): Session | null {
    return this.#session;
  }

  /** Forgets the session and the in-memory credentials, and clears the store. */
  async logout(): Promise<void> {
    this.#session = null;
    this.#credentials = undefined;
    await this.sessionStore.clear();
  }

  /**
   * The signed-in account. Signs in first when the client was given credentials and holds no
   * session yet; otherwise throws `TechnogymAuthError`.
   */
  async user(): Promise<UserInfo> {
    return (await this.#requireSession()).user;
  }

  /**
   * The facility training paths are sent to (see `TechnogymClientOptions.facility`), or `null` for
   * an account with no facility. Live on 2026-10-31, an account whose login listed no facilities
   * got the same answers with no facility prefix as with any prefix, so paths go out unprefixed.
   */
  facilityOf(user: UserInfo): Facility | null {
    if (!this.#facility) return user.facilities[0] ?? null;
    const facility = user.facilities.find((f) => f.id === this.#facility || f.url === this.#facility);
    if (!facility) throw new TechnogymError(`The account has no facility "${this.#facility}"`);
    return facility;
  }

  async #requireSession(): Promise<Session> {
    if (this.#session) return this.#session;
    if (this.#credentials) return this.#signIn();
    throw new TechnogymAuthError("Not signed in: call login() or loadSession() first");
  }

  /** Concurrent sign-ins collapse into one login request. */
  #signIn(): Promise<Session> {
    const credentials = this.#credentials;
    if (!credentials) return Promise.reject(new TechnogymAuthError("No credentials to sign in with"));
    this.#signingIn ??= (async () => {
      try {
        const session = await this.#loginRequest(credentials);
        this.#session = session;
        await this.sessionStore.save(session);
        return session;
      } finally {
        // Reset on success and failure alike, so a failed login never wedges the client.
        this.#signingIn = null;
      }
    })();
    return this.#signingIn;
  }

  async #loginRequest({ email, password }: Credentials): Promise<Session> {
    let body: Envelope;
    try {
      const res = await this.#fetcher.request(`${CORE_URL}${LOGIN_PATH}`, {
        method: "POST",
        json: { username: email, password, keepMeLoggedIn: true },
        headers: appHeaders(),
      });
      body = await parseEnvelope(res);
    } catch (cause) {
      if (cause instanceof TechnogymAuthError) {
        throw new TechnogymAuthError(`Login failed: ${cause.message}`, { cause });
      }
      throw cause;
    }
    if (body.errors?.length) throw new TechnogymAuthError(`Login failed: ${errorsText(body.errors)}`);
    const data = (body.data ?? body) as Record<string, unknown>;
    const token = data["token"];
    const user = parseUser(data);
    if (typeof token !== "string" || !token || !user) {
      throw new TechnogymAuthError(`Login failed: unexpected response (result=${JSON.stringify(data["result"])})`);
    }
    return { token, user, savedAt: Date.now() };
  }

  /**
   * POSTs `body` to a training endpoint and returns the envelope's `data` (or the whole body when
   * it has none). `path` is relative to the facility, e.g. `/Training/User/{userId}/MyMovergy`;
   * `{userId}` is replaced with the signed-in user's id. For endpoints `Technogym` has no method for.
   *
   * A rejected session is renewed once, when the client has credentials, and the call repeated.
   */
  async services<T = unknown>(path: string, body: unknown = {}, options: ServiceOptions = {}): Promise<T | null> {
    const session = await this.#requireSession();
    try {
      return await this.#servicesOnce<T>(session, path, body, options);
    } catch (error) {
      if (!(error instanceof TechnogymAuthError) || !this.#credentials) throw error;
      // Another call may already have renewed the token while this one was in flight.
      const renewed = this.#session && this.#session.token !== session.token ? this.#session : await this.#signIn();
      return this.#servicesOnce<T>(renewed, path, body, options);
    }
  }

  async #servicesOnce<T>(session: Session, path: string, body: unknown, options: ServiceOptions): Promise<T | null> {
    const facility = this.facilityOf(session.user);
    const resolved = path.replaceAll("{userId}", encodeURIComponent(session.user.userId));
    const headers = new Headers(appHeaders());
    headers.set("authorization", `Bearer ${session.token}`);
    const prefix = facility?.url ? `/${encodeURIComponent(facility.url)}` : "";
    const res = await this.#fetcher.request(`${SERVICES_URL}${prefix}${resolved}`, {
      method: "POST",
      json: body,
      headers,
      timeoutMs: options.timeoutMs,
      retry: options.retry ?? true,
    });
    const envelope = await parseEnvelope(res);
    const action = resolved.split("/").pop() ?? resolved;
    if (envelope.errors?.length) {
      if (isAuthErrorEntry(envelope.errors)) {
        throw new TechnogymAuthError(`${action}: mywellness rejected the session (${errorsText(envelope.errors)})`);
      }
      throw new TechnogymApiError(`${action}: ${errorsText(envelope.errors)}`, action, envelope.errors);
    }
    const fromHeader = res.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    await this.#adoptRotatedToken(session, fromHeader || envelope.token);
    return ("data" in envelope ? envelope.data : envelope) as T | null;
  }

  /**
   * A mywellness token lives one hour (`expireIn: 3600`, seen live on 2026-10-31), and responses
   * hand out a fresh one in the `authorization` header (and often the envelope's `token`). Keeping
   * it is what lets a session outlive the hour while it is in use.
   */
  async #adoptRotatedToken(session: Session, token: unknown): Promise<void> {
    if (typeof token !== "string" || !token || token === session.token) return;
    if (this.#session !== session) return; // a newer session already replaced this one
    this.#session = { ...session, token, savedAt: Date.now() };
    await this.sessionStore.save(this.#session);
  }
}

/** Parses a JSON response body; a non-JSON 200 becomes a `TechnogymError`, never a bare SyntaxError. */
async function parseEnvelope(res: Response): Promise<Envelope> {
  const text = await res.text();
  if (text.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new TechnogymError("mywellness returned a non-JSON response", { cause });
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Envelope) : { data: parsed };
}
