import os from "node:os";
import path from "node:path";
import {
  FileSessionStore,
  Technogym,
  TechnogymAuthError,
  TechnogymClient,
  type Credentials,
  type TechnogymClientOptions,
} from "technogym-js";

export interface McpConfig {
  sessionDir: string;
  /** Set only when BOTH email and password are configured. */
  credentials: Credentials | null;
  /** Facility id or url slug; `undefined` means the account's first facility. */
  facility: string | undefined;
}

const setting = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v && !v.includes("${") ? v : undefined;
};

/** Reads `TECHNOGYM_*` settings; `MYWELLNESS_EMAIL`/`MYWELLNESS_PASSWORD` are accepted too. */
export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const email = setting(env["TECHNOGYM_EMAIL"]) ?? setting(env["MYWELLNESS_EMAIL"]);
  // The password is used as typed: spaces can be part of it.
  const password = setting(env["TECHNOGYM_PASSWORD"]) ? env["TECHNOGYM_PASSWORD"] : setting(env["MYWELLNESS_PASSWORD"]) ? env["MYWELLNESS_PASSWORD"] : undefined;
  return {
    sessionDir: setting(env["TECHNOGYM_MCP_SESSION_DIR"]) ?? path.join(os.homedir(), ".technogym-mcp", "session"),
    credentials: email && password ? { email, password } : null,
    facility: setting(env["TECHNOGYM_FACILITY"]),
  };
}

/** No usable login. `reason` says why, when there is more to say than "none saved". */
export class NotLoggedInError extends TechnogymAuthError {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** Where tools get their `Technogym` from. */
export interface Session {
  get(): Promise<Technogym>;
  /** Drops the cached client so the next `get()` reloads the saved session from disk. */
  reset(): void;
}

export interface FileSessionOptions {
  credentials?: Credentials | null;
  facility?: string;
  client?: Omit<TechnogymClientOptions, "sessionStore" | "credentials" | "facility">;
}

/**
 * The saved session wins. Configured credentials sign in when there is none, and at most ONCE
 * per process if that fails: a wrong password retried on every tool call would get the account
 * locked. After one successful sign-in the client keeps the credentials and renews an expired
 * token on its own.
 */
export function fileSession(sessionDir: string, options: FileSessionOptions = {}): Session {
  const { credentials = null } = options;
  let current: Promise<Technogym> | null = null;
  let attempted = false;
  let failure: string | undefined;

  const open = async (): Promise<Technogym> => {
    const store = new FileSessionStore(sessionDir);
    const saved = await store.load();
    // Credentials that already failed once are never handed to the client for automatic renewal.
    const client = new TechnogymClient({
      ...options.client,
      sessionStore: store,
      facility: options.facility,
      credentials: credentials && failure === undefined ? credentials : undefined,
    });
    if (saved) {
      client.setSession(saved);
      return new Technogym(client);
    }
    if (credentials && !attempted) {
      attempted = true;
      try {
        await client.login(credentials.email, credentials.password);
        return new Technogym(client);
      } catch (error) {
        failure = `signing in with the configured email and password failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    throw new NotLoggedInError(`No saved mywellness login in ${sessionDir}`, failure);
  };

  return {
    get() {
      current ??= open().catch((error: unknown) => {
        current = null; // never cache a failure: a login made later is picked up on the next call
        throw error;
      });
      return current;
    },
    reset() {
      current = null;
    },
  };
}
