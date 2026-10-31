import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { TechnogymClient } from "../src/client.js";
import { MemorySessionStore } from "../src/auth/session-store.js";
import {
  TechnogymApiError,
  TechnogymAuthError,
  TechnogymError,
  TechnogymHttpError,
} from "../src/errors.js";
import { LOGIN_URL, SERVICES, USER, loginHandler, session, type Seen } from "./helpers/mywellness.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const fast = { retries: 2, backoffMs: 0 };

describe("login", () => {
  it("sends the app headers and saves the session", async () => {
    const seen: Seen[] = [];
    server.use(loginHandler(seen));
    const store = new MemorySessionStore();
    const client = new TechnogymClient({ sessionStore: store });

    const s = await client.login("a@b.c", "pw");

    expect(s.token).toBe("tok-1");
    expect(s.user.userId).toBe("u1");
    expect(s.user.facilities[0]!.url).toBe("my-gym");
    expect(seen[0]!.body).toEqual({ username: "a@b.c", password: "pw", keepMeLoggedIn: true });
    expect(seen[0]!.headers.get("x-mwapps-client")).toBe("enduserweb");
    expect(seen[0]!.headers.get("authorization")).toBeNull();
    expect(await store.load()).toEqual(s);
  });

  it("throws TechnogymAuthError when mywellness reports errors", async () => {
    server.use(http.post(LOGIN_URL, () => HttpResponse.json({ errors: [{ errorMessage: "Wrong password" }] })));
    const err = await new TechnogymClient().login("a@b.c", "bad").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TechnogymAuthError);
    expect((err as Error).message).toContain("Wrong password");
  });

  it("throws TechnogymAuthError on a response without a token", async () => {
    server.use(http.post(LOGIN_URL, () => HttpResponse.json({ data: { result: "Failed" } })));
    await expect(new TechnogymClient().login("a@b.c", "pw")).rejects.toThrow(/result="Failed"/);
  });

  it("does not retry the login POST", async () => {
    let calls = 0;
    server.use(
      http.post(LOGIN_URL, () => {
        calls++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await expect(new TechnogymClient(fast).login("a@b.c", "pw")).rejects.toBeInstanceOf(TechnogymHttpError);
    expect(calls).toBe(1);
  });
});

describe("services", () => {
  it("throws TechnogymAuthError without a session or credentials", async () => {
    await expect(new TechnogymClient().services("/x")).rejects.toThrow(/Not signed in/);
  });

  it("posts to the facility with the bearer token and resolves {userId}", async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(`${USER}/MyMovergy`, async ({ request }) => {
        seen.push({ url: request.url, body: await request.json(), headers: request.headers });
        return HttpResponse.json({ data: { movergy: 42 } });
      }),
    );
    const client = new TechnogymClient();
    client.setSession(session());

    await expect(client.services("/Training/User/{userId}/MyMovergy")).resolves.toEqual({ movergy: 42 });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok-1");
    expect(seen[0]!.headers.get("x-mwapps-appid")).toBe("EC1D38D7-D359-48D0-A60C-D8C0B8FB9DF9");
    expect(seen[0]!.body).toEqual({});
  });

  it("returns the whole body when the envelope has no data", async () => {
    server.use(http.post(`${SERVICES}/x`, () => HttpResponse.json({ items: [] })));
    const client = new TechnogymClient();
    client.setSession(session());
    await expect(client.services("/x")).resolves.toEqual({ items: [] });
  });

  it("throws TechnogymApiError for non-auth envelope errors", async () => {
    server.use(http.post(`${SERVICES}/Thing`, () => HttpResponse.json({ errors: [{ details: "ApplicationNotValid" }] })));
    const client = new TechnogymClient();
    client.setSession(session());
    const err = await client.services("/Thing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TechnogymApiError);
    expect((err as TechnogymApiError).action).toBe("Thing");
    expect((err as TechnogymApiError).errors).toEqual([{ details: "ApplicationNotValid" }]);
  });

  it("throws TechnogymAuthError for an auth envelope error when it cannot sign in again", async () => {
    server.use(http.post(`${SERVICES}/x`, () => HttpResponse.json({ errors: [{ details: "TokenNotValid" }] })));
    const client = new TechnogymClient();
    client.setSession(session());
    await expect(client.services("/x")).rejects.toBeInstanceOf(TechnogymAuthError);
  });

  it("signs in again once and repeats the call when the token is rejected", async () => {
    const logins: Seen[] = [];
    const tokens: (string | null)[] = [];
    server.use(
      loginHandler(logins),
      http.post(`${SERVICES}/x`, ({ request }) => {
        const auth = request.headers.get("authorization");
        tokens.push(auth);
        return auth === "Bearer stale"
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ data: { ok: true } });
      }),
    );
    const store = new MemorySessionStore();
    const client = new TechnogymClient({ sessionStore: store, credentials: { email: "a@b.c", password: "pw" } });
    client.setSession(session("stale"));

    await expect(client.services("/x")).resolves.toEqual({ ok: true });
    expect(tokens).toEqual(["Bearer stale", "Bearer tok-1"]);
    expect(logins).toHaveLength(1);
    expect((await store.load())?.token).toBe("tok-1");
  });

  it("collapses concurrent re-logins into one", async () => {
    const logins: Seen[] = [];
    server.use(
      loginHandler(logins),
      http.post(`${SERVICES}/x`, ({ request }) =>
        request.headers.get("authorization") === "Bearer stale"
          ? HttpResponse.json({ errors: [{ details: "TokenExpired" }] })
          : HttpResponse.json({ data: 1 }),
      ),
    );
    const client = new TechnogymClient({ credentials: { email: "a@b.c", password: "pw" } });
    client.setSession(session("stale"));
    await expect(Promise.all([client.services("/x"), client.services("/x"), client.services("/x")])).resolves.toEqual([
      1, 1, 1,
    ]);
    expect(logins).toHaveLength(1);
  });

  it("signs in lazily when given credentials", async () => {
    const logins: Seen[] = [];
    server.use(loginHandler(logins), http.post(`${SERVICES}/x`, () => HttpResponse.json({ data: "ok" })));
    const client = new TechnogymClient({ credentials: { email: "a@b.c", password: "pw" } });
    await expect(client.services("/x")).resolves.toBe("ok");
    expect(logins).toHaveLength(1);
  });

  it("adopts and saves a rotated token", async () => {
    server.use(http.post(`${SERVICES}/x`, () => HttpResponse.json({ data: 1, token: "tok-new" })));
    const store = new MemorySessionStore();
    const client = new TechnogymClient({ sessionStore: store });
    client.setSession(session());
    await client.services("/x");
    expect(client.getSession()?.token).toBe("tok-new");
    expect((await store.load())?.token).toBe("tok-new");
  });

  it("prefers the fresh token in the authorization response header", async () => {
    server.use(
      http.post(`${SERVICES}/x`, () =>
        HttpResponse.json({ data: 1, token: "tok-envelope" }, { headers: { authorization: "Bearer tok-header" } }),
      ),
    );
    const store = new MemorySessionStore();
    const client = new TechnogymClient({ sessionStore: store });
    client.setSession(session());
    await client.services("/x");
    expect(client.getSession()?.token).toBe("tok-header");
    expect((await store.load())?.token).toBe("tok-header");
  });

  it("retries a read on 503", async () => {
    let calls = 0;
    server.use(
      http.post(`${SERVICES}/x`, () => {
        calls++;
        return calls < 2 ? new HttpResponse(null, { status: 503 }) : HttpResponse.json({ data: "ok" });
      }),
    );
    const client = new TechnogymClient(fast);
    client.setSession(session());
    await expect(client.services("/x")).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("turns a non-JSON 200 into a TechnogymError", async () => {
    server.use(http.post(`${SERVICES}/x`, () => new HttpResponse("<html>", { status: 200 })));
    const client = new TechnogymClient();
    client.setSession(session());
    await expect(client.services("/x")).rejects.toThrow(/non-JSON/);
  });

  it("sends paths without a facility prefix when the account has none", async () => {
    const urls: string[] = [];
    server.use(
      http.post("https://services.mywellness.com/Training/User/u1/MyMovergy", ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json({ data: { movergy: 1 } });
      }),
    );
    const s = session();
    s.user.facilities = [];
    const client = new TechnogymClient();
    client.setSession(s);
    await client.services("/Training/User/{userId}/MyMovergy");
    expect(urls).toEqual(["https://services.mywellness.com/Training/User/u1/MyMovergy"]);
  });

  it("uses the facility option, by id or url", async () => {
    const urls: string[] = [];
    server.use(
      http.post("https://services.mywellness.com/:facility/x", ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json({ data: 1 });
      }),
    );
    const s = session();
    s.user.facilities.push({ id: "f2", url: "other-gym", name: "Other" });
    const client = new TechnogymClient({ facility: "f2" });
    client.setSession(s);
    await client.services("/x");
    expect(urls).toEqual(["https://services.mywellness.com/other-gym/x"]);

    const missing = new TechnogymClient({ facility: "nope" });
    missing.setSession(s);
    await expect(missing.services("/x")).rejects.toBeInstanceOf(TechnogymError);
  });
});

describe("logout", () => {
  it("clears the session and the store", async () => {
    const store = new MemorySessionStore();
    await store.save(session());
    const client = new TechnogymClient({ sessionStore: store });
    expect(await client.loadSession()).toBe(true);
    await client.logout();
    expect(client.getSession()).toBeNull();
    expect(await store.load()).toBeNull();
  });
});
