import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth/session-store.js";
import { session } from "./helpers/mywellness.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "technogym-js-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileSessionStore", () => {
  it("round-trips a session", async () => {
    const store = new FileSessionStore(join(dir, "nested"));
    await store.save(session());
    await expect(store.load()).resolves.toEqual(session());
  });

  it("writes the file with mode 0600 on POSIX", async () => {
    const store = new FileSessionStore(dir);
    await store.save(session());
    if (process.platform !== "win32") {
      expect((await stat(join(dir, "session.json"))).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(join(dir, "session.json"), "utf8")).token).toBe("tok-1");
  });

  it("returns null for a missing, corrupt or incomplete file", async () => {
    const store = new FileSessionStore(dir);
    await expect(store.load()).resolves.toBeNull();
    await writeFile(join(dir, "session.json"), "{not json");
    await expect(store.load()).resolves.toBeNull();
    await writeFile(join(dir, "session.json"), JSON.stringify({ token: "t", user: { userId: "u" } }));
    await expect(store.load()).resolves.toBeNull();
  });

  it("clear removes the file", async () => {
    const store = new FileSessionStore(dir);
    await store.save(session());
    await store.clear();
    await expect(store.load()).resolves.toBeNull();
  });
});
