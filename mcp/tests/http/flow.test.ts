import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { TechnogymAuthError, type Session as TgSession } from "technogym-js";
import { afterEach, describe, expect, it } from "vitest";
// eslint-disable-next-line no-restricted-imports -- the server's own modules, not the library
import { createHttpApp } from "../../src/http/app.js";
// eslint-disable-next-line no-restricted-imports -- the server's own modules, not the library
import { loadSqlite, MemoryGrantStore, SqliteGrantStore, type GrantStore } from "../../src/http/grants.js";
// eslint-disable-next-line no-restricted-imports -- the server's own modules, not the library
import { Sealer } from "../../src/http/seal.js";
// eslint-disable-next-line no-restricted-imports -- the server's own modules, not the library
import type { TechnogymAuth } from "../../src/http/technogym-auth.js";
import { authorizePage, mcpClient, pkce, postSignIn, register, REDIRECT, signIn, tokenRequest } from "./oauth-dance.js";

const PASSWORD = "right-password";
/** Distinctive, so a test can prove it never reaches the database file. */
const SECRET_TOKEN = "MYWELLNESS-BEARER-SECRET";

const SESSION: TgSession = {
  token: SECRET_TOKEN,
  savedAt: 0,
  user: { userId: "u1", firstName: "Ana", lastName: "B", nickName: "", measurementSystem: "Metric", culture: "en-GB", facilities: [] },
};

const fakeAuth = (): TechnogymAuth => ({
  async login(_email, password) {
    if (password !== PASSWORD) throw new TechnogymAuthError("Login failed: Wrong password");
    return SESSION;
  },
});

type Handler = (url: string, init: RequestInit) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const movergy: Handler = () => json({ data: { movergy: 77 } });

const servers: http.Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
});

async function start(o: { grants?: GrantStore; mywellness?: Handler; trustProxy?: boolean; clientIpHeader?: string } = {}) {
  const server = http.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const grants = o.grants ?? new MemoryGrantStore();
  const calls: { url: string; auth: string | null }[] = [];
  const handler = o.mywellness ?? movergy;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init.headers).get("authorization") });
    return handler(url, init);
  }) as typeof fetch;
  const logged: Record<string, unknown>[] = [];
  server.on(
    "request",
    createHttpApp({
      publicUrl: new URL(base),
      sealer: new Sealer([randomBytes(32)]),
      grants,
      auth: fakeAuth(),
      version: "test",
      trustProxy: o.trustProxy,
      clientIpHeader: o.clientIpHeader,
      technogymClient: { fetchImpl, retries: 0 },
      log: (l) => logged.push(l),
    }),
  );
  return { base, grants, logged, calls };
}

const textOf = (r: Awaited<ReturnType<Awaited<ReturnType<typeof mcpClient>>["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0]!.text;

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);

describe.skipIf(NODE_MAJOR < 20)("hosted MCP over HTTP", () => {
  it("answers health checks, and 405 for GET/DELETE /mcp", async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/mcp/healthz`)).text()).toBe("ok");
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: "DELETE" })).status).toBe(405);
  });

  it("challenges an unauthenticated client and publishes discovery metadata", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [`${base}/`] });
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ authorization_endpoint: `${base}/mcp/oauth/authorize`, token_endpoint: `${base}/mcp/oauth/token` });
  });

  it("signs in, lists the tools and runs one with the user's own mywellness token", async () => {
    const { base, calls, logged } = await start();
    const { accessToken } = await signIn(base, { email: "a@b.c", password: PASSWORD });
    const client = await mcpClient(base, accessToken);
    expect((await client.listTools()).tools).toHaveLength(6);
    const info = JSON.parse(textOf(await client.callTool({ name: "get_account_info", arguments: {} })));
    expect(info).toMatchObject({ userId: "u1", movergy: 77 });
    expect(calls).toEqual([{ url: "https://services.mywellness.com/Training/User/u1/MyMovergy", auth: `Bearer ${SECRET_TOKEN}` }]);
    await client.close();
    const call = logged.find((l) => l["rpc"] === "tools/call");
    expect(Object.keys(call!).sort()).toEqual(["grant", "ms", "rpc", "status", "tool", "user"]);
  });

  it("shows the sign-in form again on a wrong password", async () => {
    const { base } = await start();
    const clientId = await register(base);
    const page = await authorizePage(base, clientId, REDIRECT, pkce().challenge);
    const request = /name="request" value="([^"]*)"/.exec(page)![1]!;
    const res = await postSignIn(base, { request, email: "a@b.c", password: "nope" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("didn&#39;t accept that email and password");
  });

  it("rejects a wrong PKCE verifier and a reused code", async () => {
    const { base } = await start();
    const clientId = await register(base);
    const { verifier, challenge } = pkce();
    const page = await authorizePage(base, clientId, REDIRECT, challenge);
    const request = /name="request" value="([^"]*)"/.exec(page)![1]!;
    const res = await postSignIn(base, { request, email: "a@b.c", password: PASSWORD });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const fields = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT };
    expect((await tokenRequest(base, { ...fields, code_verifier: pkce().verifier })).status).toBe(400);
    expect((await tokenRequest(base, { ...fields, code_verifier: verifier })).status).toBe(200);
    expect((await tokenRequest(base, { ...fields, code_verifier: verifier })).status).toBe(400);
  });

  it("rotates refresh tokens and disconnects on a late replay", async () => {
    const { base } = await start();
    const first = await signIn(base, { email: "a@b.c", password: PASSWORD });
    const refresh = (token: string) => tokenRequest(base, { grant_type: "refresh_token", refresh_token: token, client_id: first.clientId });
    const second = (await (await refresh(first.refreshToken)).json()) as { access_token: string; refresh_token: string };
    expect((await mcpClient(base, second.access_token)).getServerVersion()?.name).toBe("technogym-mcp");
    await refresh(second.refresh_token);
    expect((await refresh(first.refreshToken)).status).toBe(400);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${second.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("disconnects when mywellness rejects the token during a tool call", async () => {
    const { base } = await start({ mywellness: () => json({ errors: [{ details: "TokenNotValid" }] }) });
    const { accessToken } = await signIn(base, { email: "a@b.c", password: PASSWORD });
    const client = await mcpClient(base, accessToken);
    const result = await client.callTool({ name: "get_account_info", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/reconnect the Technogym connector/);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("keeps a transient mywellness failure from disconnecting", async () => {
    const { base } = await start({ mywellness: () => new Response("down", { status: 503 }) });
    const { accessToken } = await signIn(base, { email: "a@b.c", password: PASSWORD });
    const client = await mcpClient(base, accessToken);
    expect((await client.callTool({ name: "get_account_info", arguments: {} })).isError).toBe(true);
    const again = await client.callTool({ name: "get_account_info", arguments: {} });
    expect(textOf(again)).toMatch(/HTTP 503/);
  });

  it("rate-limits sign-in per CLIENT_IP_HEADER address", async () => {
    const { base } = await start({ clientIpHeader: "cf-connecting-ip" });
    const fail = (ip: string) => postSignIn(base, { request: "x", email: "a", password: "b" }, { "cf-connecting-ip": ip });
    for (let i = 0; i < 5; i++) expect((await fail("203.0.113.1")).status).toBe(400);
    expect((await fail("203.0.113.1")).status).toBe(429);
    expect((await fail("203.0.113.2")).status).toBe(400);
  });

  it.skipIf(loadSqlite() === null)("never writes the mywellness token or email to the database", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "tg-grants-")), "grants.db");
    const grants = await SqliteGrantStore.open(file);
    const { base } = await start({ grants });
    await signIn(base, { email: "someone@example.com", password: PASSWORD });
    expect(grants.count()).toEqual({ active: 1, total: 1 });
    grants.close();
    const bytes = readFileSync(file).toString("latin1") + (() => {
      try {
        return readFileSync(`${file}-wal`).toString("latin1");
      } catch {
        return "";
      }
    })();
    expect(bytes).not.toContain(SECRET_TOKEN);
    expect(bytes).not.toContain("someone@example.com");
    expect(bytes).not.toContain(PASSWORD);
  });
});
