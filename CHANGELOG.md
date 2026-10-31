# Changelog

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
