<div align="center">

# technogym-js

**TypeScript client for Technogym mywellness**

<sub>**Unofficial.** Not affiliated with, endorsed by, or supported by Technogym. Technogym and
mywellness are trademarks of Technogym S.p.A.</sub>

</div>

A zero-dependency TypeScript client for Technogym's **mywellness** cloud, for **Node and Next.js
server runtimes**. It reads your gym training history: workout sessions, every exercise with
per-set reps and weight, the machine's full summary (a Skillrun's running cadence, power, step
length and ground contact time; a strength machine's estimated 1RM), per-second treadmill and
bike data, and whole-session heart rate.

Technogym's official API is partner-only. This library speaks the same JSON API the official
end-user web app (endusernext.mywellness.com) uses, signing in with your normal email and password.
No HTML scraping, but it will break if Technogym changes the login flow or its client-trust rules.

On top of the endpoints, it does the analysis the API leaves out: the summary block omits most
machine channels, so `analyzeExercise` computes per-channel stats and splits a run into **intervals
detected from setpoint changes** (speed, grade, level), console laps, or fixed windows.

If you're an AI coding agent (or configuring one), read [`AGENTS.md`](AGENTS.md) first.

## 📦 Install

```sh
npm install technogym-js
```

Node 18 or later. Server-only: credentials and the session token must never reach a browser.

## 🚀 Quick start

```ts
import { FileSessionStore, Technogym, TechnogymClient } from "technogym-js";

const client = new TechnogymClient({ sessionStore: new FileSessionStore("./session") });
if (!(await client.loadSession())) {
  await client.login(process.env.TECHNOGYM_EMAIL!, process.env.TECHNOGYM_PASSWORD!);
}

const technogym = new Technogym(client);

// Overview: newest first. sessionId + date address a session.
const sessions = await technogym.listSessions("2026-09-01", "2026-09-30");

// Every exercise, sets, machine summary, efficacy and muscle scores.
const session = await technogym.getWorkoutSession(sessions[0].sessionId, sessions[0].date);

// Per-second data of a cardio exercise, plus intervals and per-channel stats.
const run = session.exercises.find((e) => e.isCardio)!;
const analyzed = await technogym.analyzeExercise(run.analyticsId);
for (const s of analyzed.segments) {
  console.log(s.interval, s.setpoint, s.paceMinPerKm, s.channels.RunningCadence);
}
```

Or let the client sign in on its own, lazily and again whenever the token is rejected:

```ts
const client = new TechnogymClient({
  credentials: { email: process.env.TECHNOGYM_EMAIL!, password: process.env.TECHNOGYM_PASSWORD! },
});
```

In a Next.js route handler add `export const runtime = "nodejs";`.

## 📚 API

### `Technogym`

| Method | Returns |
|---|---|
| `getUser()` | The account: user id, name, culture, measurement system, facilities. From the session, no request. |
| `getMovergy()` | The current Movergy score, or `null`. |
| `listSessions(from, to, { onlyWorkouts = true })` | `SessionSummary[]`, newest first: id, date, time, name, duration, MOVEs, calories, exercise counts, effectiveness and compliance. |
| `findSessionDate(sessionId, lookbackDays = 365)` | A session's `YYYY-MM-DD`, found by scanning history. |
| `getWorkoutSession(sessionId, date?)` | `WorkoutSession`: every performed exercise with machine, sets, prescribed sets, summary, workload ranges, estimated figures, console metadata; session efficacy, muscle scores, totals. |
| `getRecentWorkouts(days = 14)` | `WorkoutSession[]` for the last N days. |
| `getExerciseAnalytics(analyticsId)` | `ExerciseAnalytics`: channel names, 1 Hz samples, HR, HR zones, laps, summary. |
| `analyzeExercise(analyticsId, { segmentBy, segmentSeconds })` | The above plus `channelStats`, `segmentMode` and `segments`. |
| `getSessionHeartRate(sessionId, date?)` | `HrSession`: timestamped HR, zones, avg/min/max HR. |
| `getWorkoutSessionRaw`, `getExerciseAnalyticsRaw`, `getSessionHeartRateRaw`, `getActivityHistoryRaw` | The untouched payloads, for anything the types do not model. |

Pass `date` whenever you have it: the API partitions sessions by day, and without it the last year
of history is scanned first. Dates are `YYYY-MM-DD` strings or `Date`s (their local calendar day).

Every metric is a `Property` of `{ value, displayValue, unit, formatted }`: `value` is in the API's
base unit (seconds, metres, kg), `displayValue` is in `unit` (what the console shows), and
`formatted` is the localised string. Names and units come back in the account's culture.

### Analytics helpers

Pure functions, exported for samples you already hold: `channelStats(samples, channels)`,
`segmentAnalytics(samples, channels, laps, { segmentBy, segmentSeconds })`,
`windowSamples(rows, fromSec, toSec)`, `downsample(rows, step)`.

`segmentBy` is `auto` (default: intervals when there are at least two, else laps, else fixed
windows), `workload`, `laps` or `fixed`. A 10 × (1 min hard / 1 min easy) treadmill session yields
20 segments, each with its setpoint, pace, distance covered and avg / max / min of every channel.
Ramps between setpoints are folded into the interval they lead into.

### `TechnogymClient`

| Member | |
|---|---|
| `new TechnogymClient(options)` | `sessionStore`, `credentials`, `facility` (id or url slug; default the first), `timeoutMs` (30 s), `retries` (3), `backoffMs`, `fetchImpl`. |
| `login(email, password)` | Signs in and saves the session. Keeps the credentials in memory to renew a rejected token. |
| `loadSession()` / `setSession()` / `getSession()` / `logout()` | Session handling. |
| `services(path, body?)` | POST to any training endpoint under the facility; `{userId}` in `path` is filled in. For endpoints `Technogym` has no method for. |

Sessions are stored by `FileSessionStore(dir)` (`session.json`, mode 0600) or
`MemorySessionStore`; implement `SessionStore` for a database.

### Errors

All extend `TechnogymError`: `TechnogymAuthError` (login failed, no session, token rejected),
`TechnogymApiError` (a 200 whose `errors` envelope is not about the session; `.action`,
`.errors`), `TechnogymNotFoundError`, `TechnogymRateLimitError` (`.retryAfter`),
`TechnogymHttpError` (`.status`, `.url`, `.body`), `TechnogymConnectionError`.

## 🤖 MCP server

[`mcp/`](mcp/README.md) is an MCP server built on this library, exposing six read-only tools to
Claude and other MCP clients.

## 🛠️ Development

```sh
cp .env.example .env     # fill in TECHNOGYM_EMAIL / TECHNOGYM_PASSWORD
npm install
npm run check            # typecheck, lint, build, test (library and MCP server)
npm run login && npm run demo
```

## 🙏 Credits

The endpoint surface and parsing follow the Technogym server in
[health_mcp](https://github.com/ErikAnkerKilbergSkallevold/health_mcp/tree/main/technogym)
(MIT). See [`NOTICE`](NOTICE).

## License

MIT
