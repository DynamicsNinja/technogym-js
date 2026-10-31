import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { TechnogymClient } from "../src/client.js";
import { Technogym } from "../src/technogym.js";
import { TechnogymError, TechnogymNotFoundError } from "../src/errors.js";
import { USER, SERVICES, session } from "./helpers/mywellness.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeTechnogym(): Technogym {
  const client = new TechnogymClient();
  client.setSession(session());
  return new Technogym(client);
}

const bodies: Record<string, unknown[]> = {};
function record(name: string, body: unknown) {
  (bodies[name] ??= []).push(body);
}
afterEach(() => {
  for (const k of Object.keys(bodies)) delete bodies[k];
});

const HISTORY = {
  data: {
    items: [
      { idCr: 1, partitionDate: 20260901, hour: 8, minute: 0, name: "Early" },
      { idCr: 3, partitionDate: 20260903, hour: 7, minute: 5, name: "Latest" },
      { idCr: 2, partitionDate: 20260901, hour: 18, minute: 30, name: "Evening" },
    ],
  },
};

const SESSION = {
  data: {
    id: "s",
    startedOn: "2026-09-03 07:05:00 +02:00",
    displayName: "Latest",
    physicalActivities: [
      { physicalActivityName: "Run", analyticsId: "an-1", performedPhysicalActivity: { id: "p1", data: {} } },
    ],
  },
};

describe("Technogym", () => {
  it("getUser comes from the session without a request", async () => {
    await expect(makeTechnogym().getUser()).resolves.toMatchObject({ userId: "u1", culture: "en-GB" });
  });

  it("getMovergy", async () => {
    server.use(http.post(`${USER}/MyMovergy`, () => HttpResponse.json({ data: { movergy: 1234 } })));
    await expect(makeTechnogym().getMovergy()).resolves.toBe(1234);
  });

  it("listSessions sends partition keys in order and sorts newest first", async () => {
    server.use(
      http.post(`${USER}/ActivityHistory`, async ({ request }) => {
        record("history", await request.json());
        return HttpResponse.json(HISTORY);
      }),
    );
    const list = await makeTechnogym().listSessions("2026-09-30", new Date(2026, 8, 1));
    expect(bodies["history"]).toEqual([{ startDay: "20260901", endDay: "20260930", justThisType: "WorkoutSession" }]);
    expect(list.map((s) => s.sessionId)).toEqual(["3", "2", "1"]);
  });

  it("listSessions without onlyWorkouts drops the type filter", async () => {
    server.use(
      http.post(`${USER}/ActivityHistory`, async ({ request }) => {
        record("history", await request.json());
        return HttpResponse.json({ data: { items: [] } });
      }),
    );
    await makeTechnogym().listSessions("2026-09-01", "2026-09-02", { onlyWorkouts: false });
    expect(bodies["history"]).toEqual([{ startDay: "20260901", endDay: "20260902" }]);
  });

  it("rejects a malformed date before any request", async () => {
    await expect(makeTechnogym().listSessions("2026-13-01", "2026-09-02")).rejects.toBeInstanceOf(TechnogymError);
  });

  it("getWorkoutSession sends idCr and partitionDate as the API expects", async () => {
    server.use(
      http.post(`${USER}/GetPerformedWorkoutSessionByIdCr`, async ({ request }) => {
        record("session", await request.json());
        return HttpResponse.json(SESSION);
      }),
    );
    const s = await makeTechnogym().getWorkoutSession("3", "2026-09-03");
    expect(bodies["session"]).toEqual([{ idCr: 3, partitionDate: "20260903" }]);
    expect(s.name).toBe("Latest");
    expect(s.exercises[0]!.analyticsId).toBe("an-1");
  });

  it("getWorkoutSession finds the date from history when it is omitted", async () => {
    server.use(
      http.post(`${USER}/ActivityHistory`, async ({ request }) => {
        record("history", await request.json());
        return HttpResponse.json(HISTORY);
      }),
      http.post(`${USER}/GetPerformedWorkoutSessionByIdCr`, async ({ request }) => {
        record("session", await request.json());
        return HttpResponse.json(SESSION);
      }),
    );
    await makeTechnogym().getWorkoutSession(2);
    expect(bodies["history"]![0]).not.toHaveProperty("justThisType");
    expect(bodies["session"]).toEqual([{ idCr: 2, partitionDate: "20260901" }]);
  });

  it("throws TechnogymNotFoundError for an unknown session", async () => {
    server.use(http.post(`${USER}/GetPerformedWorkoutSessionByIdCr`, () => HttpResponse.json({ data: null })));
    await expect(makeTechnogym().getWorkoutSession(9, "2026-09-01")).rejects.toBeInstanceOf(TechnogymNotFoundError);
  });

  it("rejects a non-integer session id", async () => {
    await expect(makeTechnogym().getWorkoutSession("abc", "2026-09-01")).rejects.toThrow(/integer/);
  });

  it("getRecentWorkouts loads every listed session", async () => {
    server.use(
      http.post(`${USER}/ActivityHistory`, () => HttpResponse.json(HISTORY)),
      http.post(`${USER}/GetPerformedWorkoutSessionByIdCr`, async ({ request }) => {
        record("session", await request.json());
        return HttpResponse.json(SESSION);
      }),
    );
    const sessions = await makeTechnogym().getRecentWorkouts(7);
    expect(sessions).toHaveLength(3);
    expect(bodies["session"]!.map((b) => (b as { idCr: number }).idCr)).toEqual([3, 2, 1]);
  });

  it("getExerciseAnalytics and analyzeExercise", async () => {
    server.use(
      http.post(`${SERVICES}/Training/CardioLog/an-1/Details`, () =>
        HttpResponse.json({
          data: {
            name: "Run",
            analitics: {
              descriptor: [{ i: 0, pr: { name: "Power" } }],
              samples: Array.from({ length: 20 }, (_, i) => ({ t: i + 1, vs: [100] })),
            },
          },
        }),
      ),
    );
    const t = makeTechnogym();
    const a = await t.getExerciseAnalytics("an-1");
    expect(a.channels).toEqual(["Power"]);
    expect(a.samples).toHaveLength(20);
    const analyzed = await t.analyzeExercise("an-1", { segmentBy: "fixed", segmentSeconds: 10 });
    expect(analyzed.channelStats["Power"]!.avg).toBe(100);
    expect(analyzed.segmentMode).toBe("fixed");
    expect(analyzed.segments).toHaveLength(2);
  });

  it("getExerciseAnalytics throws TechnogymNotFoundError on an empty payload", async () => {
    server.use(http.post(`${SERVICES}/Training/CardioLog/none/Details`, () => HttpResponse.json({ data: {} })));
    await expect(makeTechnogym().getExerciseAnalytics("none")).rejects.toBeInstanceOf(TechnogymNotFoundError);
  });

  it("getSessionHeartRate sends partitionDate as a number", async () => {
    server.use(
      http.post(`${USER}/GetHrSession`, async ({ request }) => {
        record("hr", await request.json());
        return HttpResponse.json({ data: { hrSamples: [{ hr: 120, timestamp: "t" }], properties: [], hrZones: [] } });
      }),
    );
    const hr = await makeTechnogym().getSessionHeartRate(3, "2026-09-03");
    expect(bodies["hr"]).toEqual([{ idCr: 3, partitionDate: 20260903 }]);
    expect(hr).toMatchObject({ sessionId: "3", date: "2026-09-03", hrSamples: [{ hr: 120, timestamp: "t" }] });
  });
});
