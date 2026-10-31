import { describe, expect, it } from "vitest";
import {
  parseExerciseAnalytics,
  parseHrSession,
  parseSessionSummary,
  parseUser,
  parseWorkoutSession,
} from "../src/parse.js";

// Synthetic fixtures mirroring real mywellness response shapes (ported from health_mcp's tests).

const prop = (name: string, value: number, formatted: string, unit = "") => ({
  physicalProperty: name,
  value,
  formattedValue: formatted,
  unitOfMeasureShortString: unit,
});

const fullProp = (name: string, value: number, display: number, formatted: string, unit: string) => ({
  physicalProperty: name,
  value,
  displayValue: display,
  formattedValue: formatted,
  unitOfMeasureShortString: unit,
});

describe("parseUser", () => {
  it("reads userContext and facilities", () => {
    const u = parseUser({
      token: "t",
      userContext: {
        id: "u1",
        firstName: "Erik",
        lastName: "S",
        nickName: "E",
        measurementSystem: "Metric",
        defaultCulture: "nb-NO",
      },
      facilities: [{ id: "f1", url: "gym", name: "Gym" }],
    });
    expect(u?.userId).toBe("u1");
    expect(u?.culture).toBe("nb-NO");
    expect(u?.facilities[0]?.url).toBe("gym");
  });

  it("returns null without a userContext id", () => {
    expect(parseUser({ result: "Failed" })).toBeNull();
  });
});

describe("parseSessionSummary", () => {
  it("maps ids, partition date, time and counts", () => {
    const s = parseSessionSummary({
      idCr: 16,
      type: "HRWorkout",
      partitionDate: 20260908,
      hour: 17,
      minute: 6,
      name: "Push",
      totalDurationInMinutes: 66,
      moves: 941,
      calories: 489,
      numberOfExerciseToDoWithGroups: 10,
      numberOfExerciseDoneWithGroups: 9,
      userWorkoutSessionId: "w",
      facilityId: "f",
    });
    expect(s.sessionId).toBe("16");
    expect(s.date).toBe("2026-09-08");
    expect(s.time).toBe("17:06");
    expect(s.durationMin).toBe(66);
    expect(s.exercisesDone).toBe(9);
  });

  it("keeps a zero score as 0, not null", () => {
    const s = parseSessionSummary({ idCr: 17, partitionDate: 20260909, workoutEffectiveness: 0, workoutCompliance: 55 });
    expect(s.workoutEffectiveness).toBe(0);
    expect(s.workoutCompliance).toBe(55);
  });
});

describe("parseWorkoutSession", () => {
  it("parses sets, prescribed sets and cardio summaries, skipping exercises never performed", () => {
    const s = parseWorkoutSession(
      {
        id: "sess",
        sessionType: "HRWorkout",
        displayName: "Leg day",
        startedOn: "2026-09-08 17:46:23 +02:00",
        closedOn: "2026-09-08",
        workoutSessionStatus: "None",
        displayDurationDoneShort: "65 min.",
        displayDurationShort: "44 min.",
        workoutEfficacy: 79,
        workoutEfficacyQuality: "Good",
        doneSummary: [prop("Calories", 489, "489 kcal"), prop("Move", 941, "941 MOVEs")],
        muscleScores: [{ muscleType: "Quadriceps", muscleName: "Quads", score: 102 }],
        physicalActivities: [
          {
            physicalActivityName: "Leg press",
            equipmentName: "Leg press #40",
            equipmentType: "SelectorizedLegPress",
            physicalActivityType: "StrengthLoad",
            isCardio: false,
            status: "Done",
            position: 1,
            analyticsId: "an1",
            muscles: [{ muscleType: "Quadriceps", muscleName: "Quads" }],
            displayPrescibedPhysicalActivity: {
              steps: [
                {
                  properties: [
                    prop("IsoReps", 10, "10 reps", "reps"),
                    prop("IsoWeight", 100, "100 kg", "kg"),
                    prop("RestTime", 60, "60 sek", "sek"),
                  ],
                },
              ],
            },
            performedPhysicalActivity: {
              id: "pa1",
              doneOn: "2026-09-08 18:03:01 +02:00",
              data: {
                data: [],
                steps: [
                  { data: [prop("IsoReps", 10, "10 reps", "reps"), prop("IsoWeight", 110, "110 kg", "kg")] },
                  { data: [prop("IsoReps", 8, "8 reps", "reps"), prop("IsoWeight", 120, "120 kg", "kg")] },
                ],
              },
            },
          },
          {
            physicalActivityName: "Bike",
            physicalActivityType: "Cardio",
            isCardio: true,
            analyticsId: "an2",
            performedPhysicalActivity: {
              id: "pa2",
              data: { data: [prop("HDistance", 5.2, "5.2 km", "km"), prop("AvgHr", 140, "140 bpm", "bpm")], steps: [] },
            },
          },
          { performedPhysicalActivity: {} },
        ],
      },
      "16",
    );
    expect(s.sessionId).toBe("16");
    expect(s.date).toBe("2026-09-08");
    expect(s.calories).toBe("489 kcal");
    expect(s.moves).toBe("941 MOVEs");
    expect(s.efficacy).toBe(79);
    expect(s.muscleScores).toEqual({ Quads: 102 });
    expect(s.exercises).toHaveLength(2);

    const [leg, bike] = s.exercises;
    expect(leg!.activityId).toBe("pa1");
    expect(leg!.analyticsId).toBe("an1");
    expect(leg!.isCardio).toBe(false);
    expect(leg!.muscles).toEqual(["Quads"]);
    expect(leg!.sets.map((x) => [x.reps, x.weightKg])).toEqual([
      [10, 110],
      [8, 120],
    ]);
    expect(leg!.sets[0]!.properties["IsoWeight"]!.formatted).toBe("110 kg");
    expect(leg!.prescribedSets[0]!.restSec).toBe(60);

    expect(bike!.isCardio).toBe(true);
    expect(bike!.sets).toEqual([]);
    expect(bike!.summary["HDistance"]!.formatted).toBe("5.2 km");
    expect(bike!.summary["AvgHr"]!.value).toBe(140);
  });

  it("keeps running dynamics, workload ranges and console metadata", () => {
    const s = parseWorkoutSession(
      {
        id: "sess",
        startedOn: "2026-09-09 21:07:36 +02:00",
        isFromTgCoach: false,
        workoutEfficacyDescription: "Du trente som en sportsutover",
        startedInFacilityId: "fac",
        extData: { mwc_client_application: "UnityCoach" },
        doneSummary: [fullProp("Calories", 479, 479, "479 kcal", "kcal")],
        physicalActivities: [
          {
            physicalActivityName: "Hurtigstart",
            physicalActivityShortName: "HS",
            physicalActivityCode: 204,
            physicalActivityId: "pa-type",
            equipmentName: "Skillrun",
            equipmentCode: 1017,
            equipmentType: "Treadmill",
            targetType: "Duration",
            isCardio: true,
            hasAdjustments: true,
            hasBeenDonePartially: false,
            estimatedDuration: 0,
            estimatedCalories: 0,
            estimatedMove: 0,
            analyticsId: "an",
            performedPhysicalActivity: {
              id: "perf",
              doneAs: "Added",
              manuallyDone: false,
              progress: 50673,
              extData: { mwc_training_id: "tid", race_id: "", mwc_so_version: "10" },
              data: {
                constraints: [
                  {
                    physicalProperty: "AvgSpeed",
                    discreteRange: { step: 0.1, min: 0.2, max: 30.0 },
                    isReadOnly: false,
                    visibility: "Visible",
                  },
                ],
                data: [
                  fullProp("Duration", 1847, 30.78, "30:47 min", "min"),
                  fullProp("AvgRunningCadence", 164, 164, "164 spm", "spm"),
                ],
                steps: [],
              },
            },
          },
        ],
      },
      "17",
    );
    expect(s.efficacyDescription.startsWith("Du trente")).toBe(true);
    expect(s.clientApplication).toBe("UnityCoach");
    expect(s.doneSummary["Calories"]!.value).toBe(479);
    const ex = s.exercises[0]!;
    expect(ex.shortName).toBe("HS");
    expect(ex.equipmentCode).toBe(1017);
    expect(ex.targetType).toBe("Duration");
    expect(ex.doneAs).toBe("Added");
    expect(ex.hasAdjustments).toBe(true);
    expect(ex.progress).toBe(50673);
    expect(ex.estimated).toEqual({ duration: 0, calories: 0, moves: 0 });
    expect(ex.workloadRanges["AvgSpeed"]!.max).toBe(30);
    expect(ex.extData).toEqual({ training_id: "tid", so_version: "10" }); // empty race_id dropped
    // base unit (seconds) vs display unit (minutes)
    expect(ex.summary["Duration"]).toEqual({ value: 1847, displayValue: 30.78, unit: "min", formatted: "30:47 min" });
  });

  it("never renders a null field as the text 'null'", () => {
    const s = parseWorkoutSession({ id: "x", startedOn: null, displayName: null, name: "Fallback" }, "1");
    expect(s.startedOn).toBe("");
    expect(s.name).toBe("Fallback");
  });
});

describe("parseExerciseAnalytics", () => {
  it("maps channels by descriptor index and skips empty samples", () => {
    const a = parseExerciseAnalytics(
      {
        name: "Bike",
        equipmentType: "Bike",
        analitics: {
          descriptor: [
            { i: 0, pr: { name: "Power" } },
            { i: 1, pr: { name: "Rpm" } },
          ],
          samples: [
            { t: 0, vs: [100, 80] },
            { t: 1, vs: [null, 82] },
            { t: 2, vs: [] },
          ],
          hr: [{ t: 0, hr: 120 }],
          hrZones: [{ name: "Z2", lowerBound: 120, upperBound: 140, secondsInZone: 30 }],
        },
        data: [{ property: "HDistance", value: "5,2", rawValue: 5.2, uM: "km" }],
      },
      "an1",
    );
    expect(a.channels).toEqual(["Power", "Rpm"]);
    expect(a.samples).toEqual([
      { t: 0, Power: 100, Rpm: 80 },
      { t: 1, Power: null, Rpm: 82 },
    ]);
    expect(a.hr).toEqual([{ t: 0, hr: 120 }]);
    expect(a.hrZones[0]!.secondsInZone).toBe(30);
    expect(a.summary["HDistance"]).toEqual({ value: 5.2, displayValue: 5.2, unit: "km", formatted: "5,2" });
  });

  it("reads laps and metadata", () => {
    const a = parseExerciseAnalytics(
      {
        name: "Hurtigstart",
        equipmentType: "Treadmill",
        date: "09.09.2026",
        target: "Duration",
        physicalActivityId: "pa-type",
        physicalActivityName: "Hurtigstart",
        analitics: {
          descriptor: [{ i: 0, pr: { name: "Speed" } }],
          samples: [{ t: 1, vs: [10] }],
          laps: [
            { n: 1, totalTime: 421, totalDistance: 1000, lapDistance: 1000, lapTime: 421 },
            { n: 2, totalTime: 785, totalDistance: 2000, lapDistance: 1000, lapTime: 364 },
          ],
        },
        data: [],
      },
      "an",
    );
    expect(a.target).toBe("Duration");
    expect(a.activityName).toBe("Hurtigstart");
    expect(a.laps[1]).toEqual({ n: 2, lapDistanceM: 1000, lapTimeSec: 364, totalDistanceM: 2000, totalTimeSec: 785 });
  });
});

describe("parseHrSession", () => {
  it("reads the summary and samples", () => {
    const h = parseHrSession(
      {
        properties: [prop("AvgHr", 99, "99 bpm", "bpm")],
        hrSamples: [{ hr: 69, timestamp: "2026-09-08 17:46:34 +02:00" }],
        hrZones: [],
      },
      "16",
      "2026-09-08",
    );
    expect(h.date).toBe("2026-09-08");
    expect(h.summary["AvgHr"]!.formatted).toBe("99 bpm");
    expect(h.summary["AvgHr"]!.value).toBe(99);
    expect(h.hrSamples[0]!.hr).toBe(69);
  });
});
