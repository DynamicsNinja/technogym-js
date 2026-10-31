# Changelog

## 0.1.1 — 2026-10-31

- `TechnogymClient` adopts the renewed token mywellness returns in the `authorization` response
  header, not only the envelope's `token`. A mywellness token lives one hour (`expireIn: 3600`)
  and is renewed by use, so this is what keeps a long-running client signed in.
- Hosted MCP server: OAuth access tokens last 20 minutes, and each refresh renews the mywellness
  token, so a connection in use stays signed in. After an hour without use the user reconnects.
- Hosted MCP server: public usage counts at `/mcp/stats` and `/mcp/stats.json`.

## 0.1.0 — 2026-10-31

First release.

- `TechnogymClient`: mywellness sign-in, session stores (`FileSessionStore`,
  `MemorySessionStore`), automatic re-login with credentials, rotated-token adoption, retries for
  reads, typed error hierarchy.
- `Technogym`: `getUser`, `getMovergy`, `listSessions`, `findSessionDate`, `getWorkoutSession`,
  `getRecentWorkouts`, `getExerciseAnalytics`, `analyzeExercise`, `getSessionHeartRate`, and raw
  twins of each read.
- Analytics helpers: `channelStats`, `segmentAnalytics` (interval detection from setpoint
  changes, laps, fixed windows), `windowSamples`, `downsample`.
- `@dynamicsninja/technogym-mcp`: an MCP server with six read-only tools.
