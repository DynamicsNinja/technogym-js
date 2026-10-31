import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  channelStats,
  downsample,
  segmentAnalytics,
  windowSamples,
  type SegmentBy,
  type Technogym,
} from "technogym-js";
import { compactJson, jsonResult, textResult } from "./results.js";
import type { Session } from "./session.js";

export interface ToolDef {
  tool: Tool;
  run(input: Record<string, unknown>): Promise<CallToolResult>;
}

class InputError extends Error {}

const str = (input: Record<string, unknown>, key: string): string | undefined => {
  const v = input[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" && typeof v !== "number") throw new InputError(`${key} must be a string`);
  return String(v);
};
const int = (input: Record<string, unknown>, key: string, fallback: number): number => {
  const v = input[key];
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new InputError(`${key} must be a number`);
  return Math.trunc(n);
};
const bool = (input: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const v = input[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "false") return v === "true";
  throw new InputError(`${key} must be a boolean`);
};

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function minusDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/** The six read-only tools of the original health_mcp server, on technogym-js. */
export function buildTools(session: Session): ToolDef[] {
  const withApi =
    (fn: (api: Technogym, input: Record<string, unknown>) => Promise<CallToolResult>) =>
    async (input: Record<string, unknown>) => {
      try {
        return await fn(await session.get(), input);
      } catch (error) {
        if (error instanceof InputError) return { isError: true, content: [{ type: "text" as const, text: error.message }] };
        throw error;
      }
    };

  return [
    {
      tool: {
        name: "get_account_info",
        title: "Account info",
        description:
          "The mywellness account: user id, name, culture, facilities and current Movergy score. Use it to check the login works.",
        inputSchema: { type: "object", properties: {} },
        annotations: READ_ONLY,
      },
      run: withApi(async (api) => jsonResult({ ...(await api.getUser()), movergy: await api.getMovergy() })),
    },
    {
      tool: {
        name: "get_workout_sessions",
        title: "List workout sessions",
        description:
          "Workout sessions in a date range, newest first. Each has session_id and date, which together identify the session for the detail tools, plus name, duration, MOVEs, calories and exercise counts. An overview only: call get_workout_session for exercises and sets, then get_exercise_analytics for splits, intervals and per-second data.",
        inputSchema: {
          type: "object",
          properties: {
            from_date: { ...DATE, description: "Start date, YYYY-MM-DD (default: 30 days before to_date)" },
            to_date: { ...DATE, description: "End date, YYYY-MM-DD (default: today)" },
            only_workouts: {
              type: "boolean",
              description: "Only gym-floor workout sessions (default true). false includes classes, outdoor, ...",
            },
          },
        },
        annotations: READ_ONLY,
      },
      run: withApi(async (api, input) => {
        const to = str(input, "to_date") ?? today();
        const from = str(input, "from_date") ?? minusDays(to, 30);
        const sessions = await api.listSessions(from, to, { onlyWorkouts: bool(input, "only_workouts", true) });
        return sessions.length ? jsonResult(sessions) : textResult(`No workout sessions found between ${from} and ${to}`);
      }),
    },
    {
      tool: {
        name: "get_workout_session",
        title: "Workout session detail",
        description:
          "Full detail of one workout session: every exercise with machine, status, duration, calories, MOVEs, muscles, performed and prescribed sets (reps, kg, rest), the machine's full summary (Skillrun: pace, speed, running cadence/power, step length, ground contact; strength: est. 1RM, total weight...), workload ranges and estimated vs done figures, plus session efficacy, muscle scores and totals. Every property is {value, displayValue, unit, formatted}: value is in the base unit (seconds, metres, kg), unit belongs to displayValue. Summaries are averages and maxima only; for splits and time series call get_exercise_analytics with an exercise's analyticsId.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "session_id from get_workout_sessions" },
            date: { ...DATE, description: "The session's date. Strongly recommended; without it the last year is scanned." },
            include_raw: { type: "boolean", description: "Also return the untouched mywellness payload under raw (large)" },
          },
          required: ["session_id"],
        },
        annotations: READ_ONLY,
      },
      run: withApi(async (api, input) => {
        const id = str(input, "session_id");
        if (!id) throw new InputError("session_id is required");
        const date = str(input, "date") ?? (await api.findSessionDate(id));
        const result: Record<string, unknown> = { ...(await api.getWorkoutSession(id, date)) };
        if (bool(input, "include_raw", false)) result["raw"] = await api.getWorkoutSessionRaw(id, date);
        return jsonResult(result);
      }),
    },
    {
      tool: {
        name: "get_recent_workouts",
        title: "Recent workouts",
        description:
          "Every workout session of the last N days, fully loaded (get_workout_sessions + get_workout_session). For splits and time series follow each exercise's analyticsId into get_exercise_analytics.",
        inputSchema: {
          type: "object",
          properties: { days: { type: "integer", minimum: 1, maximum: 365, description: "Look-back window (default 14)" } },
        },
        annotations: READ_ONLY,
      },
      run: withApi(async (api, input) => {
        const days = Math.max(1, Math.min(int(input, "days", 14), 365));
        const sessions = await api.getRecentWorkouts(days);
        return sessions.length ? jsonResult(sessions) : textResult(`No workout sessions found in the last ${days} days`);
      }),
    },
    {
      tool: {
        name: "get_exercise_analytics",
        title: "Exercise analytics",
        description:
          "Granular analytics for one exercise, coarse to fine: summary totals; channelStats (avg/max/min per machine channel over the full 1 Hz data); laps (console auto-laps, per km on a treadmill); segments, by default one per INTERVAL detected from setpoint changes (speed/grade/level), each with start/end, setpoint, pace, distance and avg/max/min of every channel; samples, the time series every 10 s by default; hr and hrZones. Channels are whatever the machine reports (Skillrun: Speed, Grade, HDistance, RunningCadence, RunningPower; bikes: Power, Rpm...). Strength machines have no time series. For interval analysis: call once with defaults, then zoom into one interval with from_sec/to_sec and sample_every_seconds=1.",
        inputSchema: {
          type: "object",
          properties: {
            analytics_id: { type: "string", description: "An exercise's analyticsId from get_workout_session" },
            sample_every_seconds: { type: "integer", minimum: 1, description: "Keep every Nth sample (default 10; 1 = full resolution)" },
            segment_by: {
              type: "string",
              enum: ["auto", "workload", "laps", "fixed"],
              description: "auto (default): intervals when there are at least two, else laps, else fixed windows",
            },
            segment_seconds: { type: "integer", minimum: 10, description: "Window length for segment_by=fixed (default 300)" },
            from_sec: { type: "integer", minimum: 0, description: "Only return samples/hr from this second (stats and segments always cover the whole exercise)" },
            to_sec: { type: "integer", minimum: 0, description: "Only return samples/hr up to this second (0 = end)" },
            include_raw: { type: "boolean", description: "Also return the untouched payload under raw, minus its per-second samples" },
          },
          required: ["analytics_id"],
        },
        annotations: READ_ONLY,
      },
      run: withApi(async (api, input) => {
        const id = str(input, "analytics_id");
        if (!id) throw new InputError("analytics_id is required");
        const segmentBy = (str(input, "segment_by") ?? "auto").toLowerCase();
        if (!["auto", "workload", "laps", "fixed"].includes(segmentBy)) {
          throw new InputError("segment_by must be auto, workload, laps or fixed");
        }
        const step = int(input, "sample_every_seconds", 10);
        const fromSec = int(input, "from_sec", 0);
        const toSec = int(input, "to_sec", 0);

        const analytics = await api.getExerciseAnalytics(id);
        const { mode, segments } = segmentAnalytics(analytics.samples, analytics.channels, analytics.laps, {
          segmentBy: segmentBy as SegmentBy,
          segmentSeconds: int(input, "segment_seconds", 300),
        });
        const samples = downsample(windowSamples(analytics.samples, fromSec, toSec), step);
        const hr = downsample(windowSamples(analytics.hr, fromSec, toSec), step);
        const result: Record<string, unknown> = {
          ...analytics,
          channelStats: channelStats(analytics.samples, analytics.channels),
          segmentMode: mode,
          segments,
          samples,
          hr,
          sampleCount: samples.length,
          hrCount: hr.length,
        };
        if (fromSec || toSec) result["window"] = { fromSec, toSec: toSec || null };
        if (bool(input, "include_raw", false)) {
          const raw = await api.getExerciseAnalyticsRaw(id);
          const an = raw["analitics"];
          if (an && typeof an === "object" && Array.isArray((an as Record<string, unknown>)["samples"])) {
            const count = ((an as Record<string, unknown>)["samples"] as unknown[]).length;
            raw["analitics"] = { ...an, samples: `<${count} samples omitted; see samples>` };
          }
          result["raw"] = raw;
        }
        return textResult(compactJson(result));
      }),
    },
    {
      tool: {
        name: "get_session_heart_rate",
        title: "Session heart rate",
        description: "The whole-session heart-rate trace: timestamped HR samples, HR zones and the session summary (avg/min/max HR, calories, MOVEs, METs).",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "session_id from get_workout_sessions" },
            date: { ...DATE, description: "The session's date (recommended; otherwise found from history)" },
            sample_every_seconds: { type: "integer", minimum: 1, description: "Keep every Nth sample (default 10; 1 = all)" },
          },
          required: ["session_id"],
        },
        annotations: READ_ONLY,
      },
      run: withApi(async (api, input) => {
        const id = str(input, "session_id");
        if (!id) throw new InputError("session_id is required");
        const hr = await api.getSessionHeartRate(id, str(input, "date"));
        const hrSamples = downsample(hr.hrSamples, int(input, "sample_every_seconds", 10));
        return textResult(compactJson({ ...hr, hrSamples, sampleCount: hrSamples.length }, ["hrSamples"]));
      }),
    },
  ];
}
