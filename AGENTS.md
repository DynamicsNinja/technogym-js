# AGENTS.md — technogym-js

Briefing for coding agents. Not a tutorial; see `README.md` for that. This file states facts an
agent needs to avoid confidently wrong code.

## 1. What this is, and the hard constraints

`technogym-js` is a zero-dependency TypeScript client for Technogym's mywellness cloud, for **Node
and Next.js server runtimes**. It talks to the undocumented JSON API of the official end-user web
app. There is no official public API; do not invent endpoints.

- **Read-only.** No method changes anything on the account. Every mywellness call, reads
  included, is an HTTP POST; the transport retries reads (`ServiceOptions.retry`, default `true`)
  but never the login POST.
- **A session is addressed by `sessionId` AND its date.** Sessions are partitioned by day. Methods
  take `date` as optional only for convenience: without it `findSessionDate` scans a year of
  history first (one extra request). Pass it whenever you have it.
- **`partitionDate` is a STRING (`"20260908"`) for `GetPerformedWorkoutSessionByIdCr` but a
  NUMBER (`20260908`) for `GetHrSession`.** This mirrors the web app; do not "fix" it.
- **The API spells two keys wrong, and the parsers depend on it:** `analitics` (the analytics
  block; `analytics` is accepted as a fallback) and `displayPrescibedPhysicalActivity`.
- **Every request carries `X-MWAPPS-APPID` / `X-MWAPPS-CLIENT` / `X-MWAPPS-CLIENTVERSION`**
  (`src/auth/constants.ts`). Without them mywellness answers `ClientApplicationNotTrusted`.
- **Errors come in a 200.** mywellness returns `{ data, errors }`; a non-empty `errors` is a
  failure. Auth-looking `details` (`TokenNotValid`, `TokenExpired`, anything containing "token")
  become `TechnogymAuthError`; the rest `TechnogymApiError`.
- **Re-login is automatic only with credentials** (constructor `credentials`, or a prior
  `login()` on the same client). A session loaded from a store with no credentials throws
  `TechnogymAuthError` when rejected. Concurrent re-logins collapse into one request.
- **Rotated tokens:** when a response envelope carries a new `token`, the client adopts it and
  saves it to the store.
- **Property units:** `value` is the base unit (s, m, kg); `unit` belongs to `displayValue`, not
  to `value`. A Skillrun `Duration` is `value: 1847` (seconds) with `displayValue: 30.78`,
  `unit: "min"`.
- **Strength exercises have no time series.** Use `Exercise.sets`, not `getExerciseAnalytics`.
- **Node runtime only, server-only, zero runtime dependencies, Node >= 18.**

## 2. Minimal working example

```ts
import { FileSessionStore, Technogym, TechnogymClient } from "technogym-js";

const client = new TechnogymClient({ sessionStore: new FileSessionStore("./session") });
if (!(await client.loadSession())) await client.login(process.env.TECHNOGYM_EMAIL!, process.env.TECHNOGYM_PASSWORD!);

const technogym = new Technogym(client);
const [latest] = await technogym.listSessions("2026-09-01", "2026-09-30");
const session = await technogym.getWorkoutSession(latest!.sessionId, latest!.date);
```

## 3. Methods and endpoints

All training paths are `POST https://services.mywellness.com/{facilityUrl}{path}`. An account can
have NO facilities (the login's `facilities` is `[]`); then paths go out with no prefix. Verified
live 2026-10-31: on such an account the server answered identically with no prefix and with any
made-up prefix.

Live-verified on 2026-10-31 (one account, bike sessions): login, `getMovergy`, `listSessions`,
`findSessionDate`, `getWorkoutSession`, `getExerciseAnalytics` / `analyzeExercise` (channels
Power, Rpm, HDistance, Level, Calories). `getSessionHeartRate` returned an empty trace for a bike
session whose exercise analytics did carry HR; for per-exercise HR use `ExerciseAnalytics.hr`.

| Method | Path | Body |
|---|---|---|
| `TechnogymClient.login` | `POST core.mywellness.com/v2/enduser/authentication/login` | `{username, password, keepMeLoggedIn: true}` |
| `getMovergy` | `/Training/User/{userId}/MyMovergy` | `{}` |
| `listSessions`, `getActivityHistoryRaw`, `findSessionDate` | `/Training/User/{userId}/ActivityHistory` | `{startDay, endDay[, justThisType: "WorkoutSession"]}` |
| `getWorkoutSession[Raw]` | `/Training/User/{userId}/GetPerformedWorkoutSessionByIdCr` | `{idCr: number, partitionDate: "yyyyMMdd"}` |
| `getSessionHeartRate[Raw]` | `/Training/User/{userId}/GetHrSession` | `{idCr: number, partitionDate: yyyyMMdd}` |
| `getExerciseAnalytics[Raw]`, `analyzeExercise` | `/Training/CardioLog/{analyticsId}/Details` | `{}` |

`getUser()` makes no request. `findSessionDate` searches every activity type
(`onlyWorkouts: false`). `getRecentWorkouts` loads sessions sequentially on purpose.

Request shapes follow health_mcp's working Python client.

## 4. Layout

`src/client.ts` transport and session · `src/technogym.ts` endpoint methods · `src/parse.ts`
pure parsers · `src/analysis.ts` stats and segmentation · `src/auth/` constants and session
stores · `mcp/` the MCP server, which may import only from `"technogym-js"` (lint-enforced).

`npm run check` runs typecheck, lint, build and both test suites.
