import type { AnalyticsSample, Lap } from "./types.js";

/**
 * Derived views over `ExerciseAnalytics.samples`: per-channel stats and interval / lap / window
 * segments. Pure functions, no HTTP. The mywellness summary block omits most machine channels
 * (RunningCadence and RunningPower on a Skillrun, for one), so these fill that gap.
 */

/** Channels that accumulate over the exercise: only the final value means anything, not the average. */
export const CUMULATIVE_CHANNELS: ReadonlySet<string> = new Set(["HDistance", "Distance", "VDistance", "Calories", "Move"]);

/**
 * Channels SET on the console rather than measured. A change in any of them starts a new interval
 * on a treadmill or bike programme.
 */
export const SETPOINT_CHANNELS = ["Speed", "Grade", "Level", "Resistance", "Incline", "Rpm_Target"] as const;

/** Setpoint blocks shorter than this are ramps and are folded into the interval they lead into. */
const MIN_INTERVAL_SEC = 10;

/**
 * Aggregates of one channel. Measured channels get `avg` and `minNonzero` over the non-zero
 * readings (the machine reports 0 while the belt is stopped); cumulative channels get `final`.
 */
export interface ChannelStats {
  max: number;
  samples: number;
  avg?: number;
  minNonzero?: number;
  final?: number;
}

/** A cumulative channel within one segment: the amount covered in it, and its value at the end. */
export interface CumulativeDelta {
  delta: number;
  end: number;
}

export type SegmentMode = "workload" | "laps" | "fixed";
/** `auto`: workload intervals when there are at least two, else laps, else fixed windows. */
export type SegmentBy = SegmentMode | "auto";

export interface Segment {
  startSec: number;
  endSec: number;
  durationSec: number;
  /** 1-based, on `workload` segments. */
  interval?: number;
  /** The constant setpoint values of a `workload` segment. */
  setpoint?: Record<string, number>;
  /** On `laps` segments. */
  lap?: number | null;
  lapDistanceM?: number | null;
  /** From the average `Speed` (km/h), when there is one. */
  paceMinPerKm?: number;
  channels: Record<string, ChannelStats | CumulativeDelta>;
}

export interface SegmentOptions {
  /** Default `auto`. */
  segmentBy?: SegmentBy;
  /** Window length for `fixed`, at least 10. Default 300. */
  segmentSeconds?: number;
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

function numbers(samples: readonly AnalyticsSample[], channel: string): number[] {
  const out: number[] = [];
  for (const row of samples) {
    const v = row[channel];
    if (typeof v === "number") out.push(v);
  }
  return out;
}

/** Per-channel aggregates over `samples`. Channels with no numeric reading are left out. */
export function channelStats(
  samples: readonly AnalyticsSample[],
  channels: readonly string[],
): Record<string, ChannelStats> {
  const stats: Record<string, ChannelStats> = {};
  for (const ch of channels) {
    const values = numbers(samples, ch);
    if (values.length === 0) continue;
    const entry: ChannelStats = { max: Math.max(...values), samples: values.length };
    if (CUMULATIVE_CHANNELS.has(ch)) {
      entry.final = values[values.length - 1];
    } else {
      const nonzero = values.filter((v) => v > 0);
      entry.avg = nonzero.length ? round(nonzero.reduce((a, b) => a + b, 0) / nonzero.length, 1) : 0;
      entry.minNonzero = nonzero.length ? Math.min(...nonzero) : 0;
    }
    stats[ch] = entry;
  }
  return stats;
}

type Bound = [start: number, end: number, meta: Partial<Segment>];

/**
 * Maximal runs of constant setpoint. The machine ramps between setpoints over a few seconds,
 * producing 1-2 s blocks; those merge into the following interval so it includes its own
 * acceleration. Fewer than two intervals is not an interval workout: returns `[]`.
 */
function workloadBounds(samples: readonly AnalyticsSample[], channels: readonly string[]): Bound[] {
  const keys = SETPOINT_CHANNELS.filter((c) => channels.includes(c));
  if (keys.length === 0) return [];
  const sig = (row: AnalyticsSample) => keys.map((k) => round(row[k] ?? 0, 1));
  const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);

  const blocks: { sig: number[]; start: number; end: number }[] = [];
  for (const row of samples) {
    const s = sig(row);
    const last = blocks[blocks.length - 1];
    if (last && same(last.sig, s)) last.end = row.t;
    else blocks.push({ sig: s, start: row.t, end: row.t });
  }

  const merged: typeof blocks = [];
  let carryStart: number | null = null;
  for (const b of blocks) {
    if (b.end - b.start + 1 < MIN_INTERVAL_SEC) {
      carryStart ??= b.start;
      continue;
    }
    merged.push({ sig: b.sig, start: carryStart ?? b.start, end: b.end });
    carryStart = null;
  }
  if (carryStart !== null) {
    const lastMerged = merged[merged.length - 1];
    const lastBlock = blocks[blocks.length - 1]!;
    if (lastMerged) lastMerged.end = lastBlock.end;
    else merged.push({ sig: blocks[0]!.sig, start: blocks[0]!.start, end: lastBlock.end });
  }
  if (merged.length < 2) return [];
  return merged.map((m, i) => [
    m.start - 1,
    m.end,
    { interval: i + 1, setpoint: Object.fromEntries(keys.map((k, j) => [k, m.sig[j]!])) },
  ]);
}

/**
 * Splits an exercise into segments and aggregates every channel per segment. Cumulative channels
 * report the distance (or calories, MOVEs) covered within the segment. A segment covers samples
 * with `startSec < t <= endSec`.
 */
export function segmentAnalytics(
  samples: readonly AnalyticsSample[],
  channels: readonly string[],
  laps: readonly Lap[],
  options: SegmentOptions = {},
): { mode: SegmentMode; segments: Segment[] } {
  const segmentBy = options.segmentBy ?? "auto";
  if (samples.length === 0) return { mode: segmentBy === "auto" ? "fixed" : segmentBy, segments: [] };

  let mode: SegmentMode = "fixed";
  let bounds: Bound[] = [];
  if (segmentBy === "auto" || segmentBy === "workload") {
    bounds = workloadBounds(samples, channels);
    if (bounds.length) mode = "workload";
  }
  if (bounds.length === 0 && (segmentBy === "auto" || segmentBy === "laps") && laps.length) {
    let prev = 0;
    for (const lap of laps) {
      if (lap.totalTimeSec == null) continue;
      bounds.push([prev, lap.totalTimeSec, { lap: lap.n, lapDistanceM: lap.lapDistanceM }]);
      prev = lap.totalTimeSec;
    }
    if (bounds.length) mode = "laps";
  }
  if (bounds.length === 0) {
    mode = "fixed";
    const step = Math.max(10, Math.trunc(options.segmentSeconds ?? 300) || 300);
    const lastT = Math.max(...samples.map((r) => r.t));
    for (let s = 0; s < lastT; s += step) bounds.push([s, Math.min(s + step, lastT), {}]);
  }

  const segments: Segment[] = [];
  for (const [start, end, meta] of bounds) {
    const rows = samples.filter((r) => start < r.t && r.t <= end);
    if (rows.length === 0) continue;
    const stats: Record<string, ChannelStats | CumulativeDelta> = channelStats(rows, channels);
    for (const ch of Object.keys(stats)) {
      if (!CUMULATIVE_CHANNELS.has(ch)) continue;
      const vals = numbers(rows, ch);
      stats[ch] = { delta: round(vals[vals.length - 1]! - vals[0]!, 2), end: vals[vals.length - 1]! };
    }
    const segment: Segment = { startSec: start, endSec: end, durationSec: end - start, ...meta, channels: stats };
    const speed = (stats["Speed"] as ChannelStats | undefined)?.avg;
    if (speed) segment.paceMinPerKm = round(60 / speed, 2);
    segments.push(segment);
  }
  return { mode, segments };
}

/** Rows with `fromSec <= t <= toSec`; `toSec` of 0 or less means no upper bound. */
export function windowSamples<T extends { t: number }>(rows: readonly T[], fromSec = 0, toSec = 0): T[] {
  const lo = Math.max(0, fromSec);
  return rows.filter((r) => r.t >= lo && (toSec <= 0 || r.t <= toSec));
}

/** Every `step`th row, starting with the first. */
export function downsample<T>(rows: readonly T[], step: number): T[] {
  const n = Math.max(1, Math.trunc(step) || 1);
  return rows.filter((_, i) => i % n === 0);
}
