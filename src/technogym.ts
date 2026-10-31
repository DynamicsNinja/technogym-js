import { channelStats, segmentAnalytics, type ChannelStats, type Segment, type SegmentMode, type SegmentOptions } from "./analysis.js";
import type { TechnogymClient } from "./client.js";
import { TechnogymError, TechnogymNotFoundError } from "./errors.js";
import {
  parseExerciseAnalytics,
  parseHrSession,
  parseSessionSummary,
  parseWorkoutSession,
} from "./parse.js";
import type {
  ExerciseAnalytics,
  HrSession,
  RawPayload,
  SessionSummary,
  UserInfo,
  WorkoutSession,
} from "./types.js";
import { addDays, toIsoDate, toPartitionKey } from "./util/dates.js";

const HISTORY_PATH = "/Training/User/{userId}/ActivityHistory";
const SESSION_PATH = "/Training/User/{userId}/GetPerformedWorkoutSessionByIdCr";
const HR_SESSION_PATH = "/Training/User/{userId}/GetHrSession";
const MOVERGY_PATH = "/Training/User/{userId}/MyMovergy";
const analyticsPath = (analyticsId: string) => `/Training/CardioLog/${encodeURIComponent(analyticsId)}/Details`;

/** Options for `listSessions`. */
export interface ListSessionsOptions {
  /**
   * Only gym-floor workout sessions (`justThisType: WorkoutSession`). Default `true`; `false`
   * includes every activity type (classes, outdoor, ...).
   */
  onlyWorkouts?: boolean;
}

/** `getExerciseAnalytics` plus the derived stats and segments of `analyzeExercise`. */
export interface AnalyzedExercise extends ExerciseAnalytics {
  /** Per-channel avg / max / min over the full 1 Hz data. */
  channelStats: Record<string, ChannelStats>;
  segmentMode: SegmentMode;
  segments: Segment[];
}

/**
 * The Technogym mywellness API, one method per endpoint. Wraps a `TechnogymClient`:
 *
 * ```ts
 * const client = new TechnogymClient({ sessionStore: new FileSessionStore("./session") });
 * await client.login(email, password);
 * const technogym = new Technogym(client);
 * const sessions = await technogym.listSessions("2026-09-01", "2026-09-30");
 * ```
 *
 * A session is addressed by its `sessionId` AND its date: the API partitions sessions by day.
 * Dates accept a `YYYY-MM-DD` string or a `Date` (its local calendar day). Read-only: there is
 * no method that changes anything on the account.
 */
export class Technogym {
  /** Wraps a client. It signs in on first use when it was given credentials. */
  constructor(
    /** The client every request goes through. */
    readonly client: TechnogymClient,
  ) {}

  /** The signed-in account: user id, name, culture and facilities. No HTTP call once signed in. */
  getUser(): Promise<UserInfo> {
    return this.client.user();
  }

  /** The account's current Movergy score, or `null` when mywellness has none. */
  async getMovergy(): Promise<number | null> {
    const data = await this.client.services<{ movergy?: number }>(MOVERGY_PATH);
    return typeof data?.movergy === "number" ? data.movergy : null;
  }

  /** The untouched `ActivityHistory` payload for a date range (bounds in either order). */
  getActivityHistoryRaw(
    from: string | Date,
    to: string | Date,
    options: ListSessionsOptions = {},
  ): Promise<RawPayload | null> {
    let start = toIsoDate(from);
    let end = toIsoDate(to);
    if (start > end) [start, end] = [end, start];
    const body: Record<string, string> = { startDay: toPartitionKey(start), endDay: toPartitionKey(end) };
    if (options.onlyWorkouts ?? true) body["justThisType"] = "WorkoutSession";
    return this.client.services<RawPayload>(HISTORY_PATH, body);
  }

  /** Sessions between two dates (inclusive, either order), newest first. An overview only. */
  async listSessions(
    from: string | Date,
    to: string | Date,
    options: ListSessionsOptions = {},
  ): Promise<SessionSummary[]> {
    const data = await this.getActivityHistoryRaw(from, to, options);
    const items = Array.isArray(data?.["items"]) ? (data["items"] as unknown[]) : [];
    return items
      .map(parseSessionSummary)
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  }

  /**
   * The date of a session, found by scanning the last `lookbackDays` (default 365) of history
   * across every activity type. Throws `TechnogymNotFoundError` when it is not there.
   */
  async findSessionDate(sessionId: string | number, lookbackDays = 365): Promise<string> {
    const today = toIsoDate(new Date());
    const sessions = await this.listSessions(addDays(today, -lookbackDays), today, { onlyWorkouts: false });
    const match = sessions.find((s) => s.sessionId === String(sessionId));
    if (!match) throw new TechnogymNotFoundError(`Session ${sessionId} not found in the last ${lookbackDays} days`);
    return match.date;
  }

  /** The untouched `GetPerformedWorkoutSessionByIdCr` payload. Pass `date`; see `getWorkoutSession`. */
  async getWorkoutSessionRaw(sessionId: string | number, date?: string | Date): Promise<RawPayload> {
    const day = await this.#resolveDate(sessionId, date);
    const data = await this.client.services<RawPayload>(SESSION_PATH, {
      idCr: idCr(sessionId),
      partitionDate: toPartitionKey(day),
    });
    if (!data?.["id"]) throw new TechnogymNotFoundError(`Session ${sessionId} on ${day} not found`);
    return data;
  }

  /**
   * Every exercise of a session with machine, sets (performed and prescribed), the machine's full
   * summary and workload ranges, plus efficacy, muscle scores and totals. Summaries are averages
   * and maxima only: for splits and time series, call `getExerciseAnalytics` with an exercise's
   * `analyticsId`. `date` is strongly recommended; without it the last year is scanned for it.
   */
  async getWorkoutSession(sessionId: string | number, date?: string | Date): Promise<WorkoutSession> {
    return parseWorkoutSession(await this.getWorkoutSessionRaw(sessionId, date), String(sessionId));
  }

  /**
   * Every workout session of the last `days` days (1-365, default 14), fully loaded, newest first.
   * One request for the list plus one per session.
   */
  async getRecentWorkouts(days = 14): Promise<WorkoutSession[]> {
    const n = Math.max(1, Math.min(Math.trunc(days) || 14, 365));
    const today = toIsoDate(new Date());
    const items = await this.listSessions(addDays(today, -n), today);
    const sessions: WorkoutSession[] = [];
    // Sequential on purpose: this is an unofficial API, and a burst of parallel calls is the
    // fastest way to get a client throttled.
    for (const item of items) sessions.push(await this.getWorkoutSession(item.sessionId, item.date));
    return sessions;
  }

  /** The untouched `CardioLog/{analyticsId}/Details` payload. */
  async getExerciseAnalyticsRaw(analyticsId: string): Promise<RawPayload> {
    if (!analyticsId) throw new TechnogymError("analyticsId is required");
    const data = await this.client.services<RawPayload>(analyticsPath(analyticsId));
    if (!data || Object.keys(data).length === 0) throw new TechnogymNotFoundError(`No analytics for ${analyticsId}`);
    return data;
  }

  /**
   * Per-second analytics of one exercise: the machine's channels (Skillrun: Speed, Grade,
   * HDistance, RunningCadence, RunningPower; bikes: Power, Rpm...), heart rate, HR zones, laps and
   * summary. Strength machines have no time series; use the sets of `getWorkoutSession`.
   */
  async getExerciseAnalytics(analyticsId: string): Promise<ExerciseAnalytics> {
    return parseExerciseAnalytics(await this.getExerciseAnalyticsRaw(analyticsId), analyticsId);
  }

  /**
   * `getExerciseAnalytics` plus per-channel stats and segments: by default one per interval
   * detected from setpoint changes (speed / grade / level), else per console lap, else fixed
   * windows. See `segmentAnalytics` to run the same analysis on samples you already have.
   */
  async analyzeExercise(analyticsId: string, options: SegmentOptions = {}): Promise<AnalyzedExercise> {
    const analytics = await this.getExerciseAnalytics(analyticsId);
    const { mode, segments } = segmentAnalytics(analytics.samples, analytics.channels, analytics.laps, options);
    return {
      ...analytics,
      channelStats: channelStats(analytics.samples, analytics.channels),
      segmentMode: mode,
      segments,
    };
  }

  /** The untouched `GetHrSession` payload. */
  async getSessionHeartRateRaw(sessionId: string | number, date?: string | Date): Promise<RawPayload> {
    const day = await this.#resolveDate(sessionId, date);
    const data = await this.client.services<RawPayload>(HR_SESSION_PATH, {
      idCr: idCr(sessionId),
      // A NUMBER here, unlike the string partitionDate of GetPerformedWorkoutSessionByIdCr.
      partitionDate: Number(toPartitionKey(day)),
    });
    if (!data || Object.keys(data).length === 0) {
      throw new TechnogymNotFoundError(`No heart-rate data for session ${sessionId}`);
    }
    return data;
  }

  /** The whole-session heart-rate trace: timestamped samples, HR zones and avg/min/max HR. */
  async getSessionHeartRate(sessionId: string | number, date?: string | Date): Promise<HrSession> {
    const day = await this.#resolveDate(sessionId, date);
    return parseHrSession(await this.getSessionHeartRateRaw(sessionId, day), String(sessionId), day);
  }

  async #resolveDate(sessionId: string | number, date: string | Date | undefined): Promise<string> {
    return date === undefined ? this.findSessionDate(sessionId) : toIsoDate(date);
  }
}

function idCr(sessionId: string | number): number {
  const n = Number(sessionId);
  if (!Number.isSafeInteger(n)) throw new TechnogymError(`sessionId must be an integer, got "${sessionId}"`);
  return n;
}
