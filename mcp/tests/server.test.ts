import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { FileSessionStore, type Session as TgSession } from "technogym-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compactJson } from "../src/results.js";
import { createServer } from "../src/server.js";
import { fileSession, loadConfig } from "../src/session.js";

const LOGIN_URL = "https://core.mywellness.com/v2/enduser/authentication/login";
const USER = "https://services.mywellness.com/my-gym/Training/User/u1";

const saved: TgSession = {
  token: "tok",
  savedAt: 0,
  user: {
    userId: "u1",
    firstName: "Ana",
    lastName: "B",
    nickName: "",
    measurementSystem: "Metric",
    culture: "en-GB",
    facilities: [{ id: "f1", url: "my-gym", name: "My Gym" }],
  },
};

const msw = setupServer();
beforeAll(() => msw.listen({ onUnhandledRequest: "error" }));
afterEach(() => msw.resetHandlers());
afterAll(() => msw.close());

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "technogym-mcp-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function connect(session = fileSession(dir)) {
  const server = createServer(session, "test");
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text: string }[])[0]!.text;

describe("technogym-mcp", () => {
  it("lists the six read-only tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_account_info",
      "get_exercise_analytics",
      "get_recent_workouts",
      "get_session_heart_rate",
      "get_workout_session",
      "get_workout_sessions",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("explains how to log in when there is no session", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_account_info", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Not logged in to mywellness.*technogym-mcp login/);
  });

  it("uses the saved session", async () => {
    await new FileSessionStore(dir).save(saved);
    msw.use(http.post(`${USER}/MyMovergy`, () => HttpResponse.json({ data: { movergy: 77 } })));
    const client = await connect();
    const info = JSON.parse(text(await client.callTool({ name: "get_account_info", arguments: {} })));
    expect(info).toMatchObject({ userId: "u1", movergy: 77 });
  });

  it("tries configured credentials only once when they fail", async () => {
    let logins = 0;
    msw.use(
      http.post(LOGIN_URL, () => {
        logins++;
        return HttpResponse.json({ errors: [{ errorMessage: "Wrong password" }] });
      }),
    );
    const client = await connect(fileSession(dir, { credentials: { email: "a@b.c", password: "bad" } }));
    const first = await client.callTool({ name: "get_account_info", arguments: {} });
    const second = await client.callTool({ name: "get_account_info", arguments: {} });
    expect(text(first)).toContain("Wrong password");
    expect(text(second)).toContain("Wrong password");
    expect(logins).toBe(1);
  });

  it("get_workout_sessions passes the range and filter", async () => {
    await new FileSessionStore(dir).save(saved);
    const bodies: unknown[] = [];
    msw.use(
      http.post(`${USER}/ActivityHistory`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ data: { items: [{ idCr: 5, partitionDate: 20260910, name: "Legs" }] } });
      }),
    );
    const client = await connect();
    const result = await client.callTool({
      name: "get_workout_sessions",
      arguments: { from_date: "2026-09-01", to_date: "2026-09-30", only_workouts: false },
    });
    expect(bodies).toEqual([{ startDay: "20260901", endDay: "20260930" }]);
    expect(JSON.parse(text(result))[0]).toMatchObject({ sessionId: "5", date: "2026-09-10" });
  });

  it("get_exercise_analytics segments, windows and downsamples", async () => {
    await new FileSessionStore(dir).save(saved);
    msw.use(
      http.post("https://services.mywellness.com/my-gym/Training/CardioLog/an/Details", () =>
        HttpResponse.json({
          data: {
            name: "Run",
            analitics: {
              descriptor: [{ i: 0, pr: { name: "Power" } }],
              samples: Array.from({ length: 100 }, (_, i) => ({ t: i + 1, vs: [100] })),
            },
          },
        }),
      ),
    );
    const client = await connect();
    const out = text(
      await client.callTool({
        name: "get_exercise_analytics",
        arguments: { analytics_id: "an", from_sec: 11, to_sec: 20, sample_every_seconds: 5, segment_by: "fixed", segment_seconds: 50 },
      }),
    );
    const data = JSON.parse(out);
    expect(data.samples.map((s: { t: number }) => s.t)).toEqual([11, 16]);
    expect(data.segments).toHaveLength(2);
    expect(data.channelStats.Power.samples).toBe(100);
    expect(data.window).toEqual({ fromSec: 11, toSec: 20 });
    expect(out).toContain('{"t":11,"Power":100}');
  });

  it("rejects a bad segment_by", async () => {
    await new FileSessionStore(dir).save(saved);
    const client = await connect();
    const result = await client.callTool({ name: "get_exercise_analytics", arguments: { analytics_id: "an", segment_by: "nope" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/segment_by/);
  });
});

describe("compactJson", () => {
  it("keeps rows on one line and the outer structure pretty", () => {
    const data = { a: 1, samples: [{ t: 1, Speed: 10 }, { t: 2, Speed: 10.5 }], hr: [] };
    const out = compactJson(data);
    expect(JSON.parse(out)).toEqual(data);
    expect(out).toContain('{"t":1,"Speed":10}');
    expect(out.startsWith("{\n  ")).toBe(true);
  });
});

describe("loadConfig", () => {
  it("needs both email and password, and accepts the MYWELLNESS_ names", () => {
    expect(loadConfig({ TECHNOGYM_EMAIL: "a@b.c" }).credentials).toBeNull();
    expect(loadConfig({ MYWELLNESS_EMAIL: "a@b.c", MYWELLNESS_PASSWORD: "pw" }).credentials).toEqual({
      email: "a@b.c",
      password: "pw",
    });
    expect(loadConfig({ TECHNOGYM_MCP_SESSION_DIR: "/x" }).sessionDir).toBe("/x");
  });
});
