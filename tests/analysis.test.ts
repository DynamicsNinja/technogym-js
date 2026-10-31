import { describe, expect, it } from "vitest";
import { channelStats, downsample, segmentAnalytics, windowSamples, type ChannelStats } from "../src/analysis.js";
import type { AnalyticsSample, Lap } from "../src/types.js";

const lap = (n: number, totalTimeSec: number, lapDistanceM: number | null = null): Lap => ({
  n,
  totalTimeSec,
  lapDistanceM,
  lapTimeSec: null,
  totalDistanceM: null,
});

describe("channelStats and lap segments", () => {
  const channels = ["Speed", "HDistance", "RunningCadence"];
  const samples: AnalyticsSample[] = Array.from({ length: 200 }, (_, i) => {
    const t = i + 1;
    return { t, Speed: t <= 100 ? 10 : 12, HDistance: t * 3, RunningCadence: t < 5 ? 0 : 160 };
  });

  it("averages measured channels over non-zero readings and keeps the final cumulative value", () => {
    const stats = channelStats(samples, channels);
    expect(stats["Speed"]!.max).toBe(12);
    expect(stats["Speed"]!.avg).toBe(11);
    expect(stats["HDistance"]).toEqual({ max: 600, samples: 200, final: 600 });
    expect(stats["RunningCadence"]!.avg).toBe(160);
  });

  it("segments by laps with pace and per-segment distance", () => {
    const { mode, segments } = segmentAnalytics(samples, channels, [lap(1, 100, 300), lap(2, 200, 300)], {
      segmentBy: "laps",
    });
    expect(mode).toBe("laps");
    expect(segments.map((s) => s.lap)).toEqual([1, 2]);
    expect((segments[0]!.channels["Speed"] as ChannelStats).avg).toBe(10);
    expect((segments[1]!.channels["Speed"] as ChannelStats).avg).toBe(12);
    expect(segments[0]!.paceMinPerKm).toBe(6);
    expect(segments[1]!.paceMinPerKm).toBe(5);
    expect(segments[1]!.channels["HDistance"]).toEqual({ delta: 297, end: 600 }); // (200-101) * 3
  });
});

describe("fixed windows", () => {
  const samples: AnalyticsSample[] = Array.from({ length: 600 }, (_, i) => ({ t: i + 1, Power: 100 }));

  it("falls back to fixed windows when there are no setpoints or laps", () => {
    const { mode, segments } = segmentAnalytics(samples, ["Power"], []);
    expect(mode).toBe("fixed"); // Power is measured, not a setpoint
    expect(segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 300],
      [300, 600],
    ]);
  });

  it("honours segmentSeconds", () => {
    const { segments } = segmentAnalytics(samples, ["Power"], [], { segmentBy: "fixed", segmentSeconds: 120 });
    expect(segments).toHaveLength(5);
    expect(segments[0]!.durationSec).toBe(120);
  });
});

/** 4 x (60 s @ 14 km/h, 60 s @ 8 km/h) with 5 s ramps, grade 1 %. */
function treadmillIntervals(): AnalyticsSample[] {
  const rows: AnalyticsSample[] = [];
  let t = 0;
  for (let rep = 0; rep < 4; rep++) {
    for (const [target, prev] of [
      [14, 8],
      [8, 14],
    ] as const) {
      for (let k = 0; k < 5; k++) {
        t++;
        rows.push({ t, Speed: Math.round((prev + ((target - prev) * (k + 1)) / 6) * 10) / 10, Grade: 1 });
      }
      for (let k = 0; k < 55; k++) {
        t++;
        rows.push({ t, Speed: target, Grade: 1 });
      }
    }
  }
  for (const r of rows) {
    r["RunningCadence"] = r["Speed"]! > 11 ? 180 : 160;
    r["HDistance"] = r.t * 3;
  }
  return rows;
}

describe("workload intervals", () => {
  const samples = treadmillIntervals();
  const channels = ["Speed", "Grade", "HDistance", "RunningCadence"];

  it("detects intervals from setpoint changes and folds ramps into the next interval", () => {
    const { mode, segments } = segmentAnalytics(samples, channels, []);
    expect(mode).toBe("workload");
    expect(segments).toHaveLength(8);
    expect(segments.map((s) => s.setpoint?.["Speed"])).toEqual([14, 8, 14, 8, 14, 8, 14, 8]);
    expect(segments[0]).toMatchObject({ interval: 1, startSec: 0, endSec: 60 });
    expect(segments[1]).toMatchObject({ startSec: 60, endSec: 120 });
    expect((segments[0]!.channels["RunningCadence"] as ChannelStats).max).toBe(180);
    expect((segments[1]!.channels["RunningCadence"] as ChannelStats).minNonzero).toBe(160);
    expect(segments[0]!.paceMinPerKm!).toBeLessThan(segments[1]!.paceMinPerKm!);
  });

  it("still segments by laps when asked", () => {
    const { mode, segments } = segmentAnalytics(samples, channels, [lap(1, 480)], { segmentBy: "laps" });
    expect(mode).toBe("laps");
    expect(segments).toHaveLength(1);
  });
});

describe("windowSamples and downsample", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ t: i + 1 }));

  it("windows inclusively, 0 meaning no upper bound", () => {
    expect(windowSamples(rows, 3, 5).map((r) => r.t)).toEqual([3, 4, 5]);
    expect(windowSamples(rows, 8, 0).map((r) => r.t)).toEqual([8, 9, 10]);
    expect(windowSamples(rows)).toHaveLength(10);
  });

  it("keeps every nth row", () => {
    expect(downsample(rows, 3).map((r) => r.t)).toEqual([1, 4, 7, 10]);
    expect(downsample(rows, 0)).toHaveLength(10);
  });
});
