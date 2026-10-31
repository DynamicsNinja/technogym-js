import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Facility, UserInfo } from "../types.js";

/** A signed-in mywellness session: the bearer token and the account it belongs to. */
export interface Session {
  /** The bearer token sent with every request. */
  token: string;
  /** The account, as the login response described it. */
  user: UserInfo;
  /** When the session was created or its token last rotated, in epoch milliseconds. */
  savedAt: number;
}

/**
 * Persists a client's session between runs. Implement it to keep sessions in a database or a
 * secret store; `FileSessionStore` and `MemorySessionStore` are ready-made.
 */
export interface SessionStore {
  /** The saved session, or `null` when there is none. */
  load(): Promise<Session | null>;
  /** Saves a session, replacing any saved before. */
  save(session: Session): Promise<void>;
  /** Removes the saved session. */
  clear(): Promise<void>;
}

/** Keeps the session in memory only, so it is lost when the process exits. The client's default. */
export class MemorySessionStore implements SessionStore {
  #session: Session | null = null;

  async load(): Promise<Session | null> {
    return this.#session;
  }
  async save(session: Session): Promise<void> {
    this.#session = session;
  }
  async clear(): Promise<void> {
    this.#session = null;
  }
}

const SESSION_FILE = "session.json";

/** Stores the session as `session.json` (mode 0600) in `dir`, which is created on the first save. */
export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  async load(): Promise<Session | null> {
    try {
      return parseSession(JSON.parse(await readFile(join(this.dir, SESSION_FILE), "utf8")));
    } catch {
      return null;
    }
  }

  async save(session: Session): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Unique per call so two processes sharing the directory never write the same temp file.
    const tmp = join(this.dir, `${SESSION_FILE}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
      await rename(tmp, join(this.dir, SESSION_FILE));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async clear(): Promise<void> {
    await rm(join(this.dir, SESSION_FILE), { force: true });
  }
}

/**
 * Validates a stored session's shape. A file missing the token, the user id or the facility list
 * is rejected whole, so `loadSession()` returns `false` and the caller signs in again rather than
 * carrying a half-valid session around.
 */
function parseSession(value: unknown): Session | null {
  if (!isRecord(value) || typeof value["token"] !== "string" || !value["token"]) return null;
  const user = value["user"];
  if (!isRecord(user) || typeof user["userId"] !== "string" || !user["userId"]) return null;
  if (!Array.isArray(user["facilities"])) return null;
  const facilities: Facility[] = [];
  for (const f of user["facilities"] as unknown[]) {
    if (!isRecord(f) || typeof f["url"] !== "string") return null;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    facilities.push({ id: str(f["id"]), url: f["url"], name: str(f["name"]) });
  }
  const text = (key: string) => (typeof user[key] === "string" ? user[key] : "");
  return {
    token: value["token"],
    user: {
      userId: user["userId"],
      firstName: text("firstName"),
      lastName: text("lastName"),
      nickName: text("nickName"),
      measurementSystem: text("measurementSystem"),
      culture: text("culture"),
      facilities,
    },
    savedAt: typeof value["savedAt"] === "number" ? value["savedAt"] : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
