import type {
  AnalyticsSample,
  Exercise,
  ExerciseAnalytics,
  Facility,
  HrSession,
  HrZone,
  Lap,
  PropertyMap,
  SessionSummary,
  SetData,
  UserInfo,
  WorkloadRange,
  WorkoutSession,
} from "./types.js";
import { fromPartitionKey } from "./util/dates.js";

/**
 * Pure parsers from mywellness payloads to the types in `types.ts`. They never throw on a
 * missing field: absent strings become `""`, absent numbers `null`, absent lists `[]`.
 */

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : {};
}

function list(value: unknown): Rec[] {
  return Array.isArray(value) ? (value as unknown[]).map(rec) : [];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "object" && value !== null ? JSON.stringify(value) : "";
}

/** The first non-empty value, as text. */
function firstText(...values: unknown[]): string {
  for (const v of values) if (v != null && v !== "") return text(v);
  return "";
}

export function intOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The login response's account, or `null` when it has no `userContext.id`. */
export function parseUser(data: unknown): UserInfo | null {
  const d = rec(data);
  const uc = rec(d["userContext"]);
  if (!uc["id"]) return null;
  const facilities: Facility[] = list(d["facilities"]).map((f) => ({
    id: text(f["id"]),
    url: text(f["url"]),
    name: text(f["name"]),
  }));
  return {
    userId: text(uc["id"]),
    firstName: text(uc["firstName"]),
    lastName: text(uc["lastName"]),
    nickName: text(uc["nickName"]),
    measurementSystem: text(uc["measurementSystem"]),
    culture: text(uc["defaultCulture"]),
    facilities,
  };
}

/** One `ActivityHistory` item. */
export function parseSessionSummary(item: unknown): SessionSummary {
  const i = rec(item);
  const pad = (v: unknown) => String(intOrNull(v) ?? 0).padStart(2, "0");
  return {
    sessionId: text(i["idCr"]),
    date: fromPartitionKey(i["partitionDate"]),
    time: `${pad(i["hour"])}:${pad(i["minute"])}`,
    name: text(i["name"]),
    type: text(i["type"]),
    durationMin: intOrNull(i["totalDurationInMinutes"] ?? i["duration"]),
    moves: intOrNull(i["moves"]),
    calories: intOrNull(i["calories"]),
    exercisesDone: intOrNull(i["numberOfExerciseDoneWithGroups"]),
    exercisesPlanned: intOrNull(i["numberOfExerciseToDoWithGroups"]),
    userWorkoutSessionId: text(i["userWorkoutSessionId"]),
    facilityId: text(i["facilityId"]),
    workoutEffectiveness: intOrNull(i["workoutEffectiveness"]),
    workoutCompliance: intOrNull(i["workoutCompliance"]),
  };
}

/**
 * Normalises mywellness property rows. Two shapes exist: session and HR rows carry `value` in the
 * base unit plus `displayValue` in `unitOfMeasureShortString`; CardioLog rows carry `rawValue`
 * already in the display unit (`uM`) and `value` as a formatted string.
 */
export function parseProperties(rows: unknown): PropertyMap {
  const out: PropertyMap = {};
  for (const p of list(rows)) {
    const key = text(p["physicalProperty"] ?? p["property"]);
    if (!key) continue;
    if ("rawValue" in p) {
      out[key] = { value: p["rawValue"], displayValue: p["rawValue"], unit: text(p["uM"]), formatted: p["value"] };
    } else {
      out[key] = {
        value: p["value"],
        displayValue: "displayValue" in p ? p["displayValue"] : p["value"],
        unit: text(p["unitOfMeasureShortString"]),
        formatted: p["formattedValue"],
      };
    }
  }
  return out;
}

function stepToSet(setNumber: number, properties: PropertyMap): SetData {
  const num = (key: string) => numOrNull(properties[key]?.value);
  return {
    setNumber,
    reps: num("IsoReps") ?? num("Reps"),
    weightKg: num("IsoWeight") ?? num("Weight"),
    restSec: num("RestTime"),
    durationSec: num("Duration"),
    properties,
  };
}

/** One `physicalActivities` entry of a session. */
export function parseExercise(activity: unknown): Exercise {
  const act = rec(activity);
  const pa = rec(act["performedPhysicalActivity"]);
  const pdata = rec(pa["data"]);
  const prescribed = rec(act["displayPrescibedPhysicalActivity"]); // sic: the API's spelling

  const workloadRanges: Record<string, WorkloadRange> = {};
  for (const c of list(pdata["constraints"])) {
    const prop = text(c["physicalProperty"]);
    if (!prop) continue;
    const range = rec(c["discreteRange"]);
    workloadRanges[prop] = {
      min: range["min"],
      max: range["max"],
      step: range["step"],
      readOnly: Boolean(c["isReadOnly"]),
      visibility: c["visibility"],
    };
  }

  const extData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec(pa["extData"]))) {
    if (v != null && v !== "") extData[k.startsWith("mwc_") ? k.slice(4) : k] = v;
  }

  return {
    activityId: text(pa["id"]),
    analyticsId: firstText(act["analyticsId"], pa["analiticsId"]), // sic
    name: text(act["physicalActivityName"]),
    machine: text(act["equipmentName"]),
    equipmentType: text(act["equipmentType"]),
    type: text(act["physicalActivityType"]),
    isCardio: Boolean(act["isCardio"]),
    status: text(act["status"]),
    doneOn: text(pa["doneOn"]),
    position: intOrNull(act["position"]),
    duration: firstText(act["displayDurationDoneShort"], act["displayDurationShort"]),
    calories: text(act["displayCaloriesDoneShort"]),
    moves: text(act["displayMoveDoneShort"]),
    muscles: list(act["muscles"]).map((m) => firstText(m["muscleName"], m["muscleType"])),
    summary: parseProperties(pdata["data"]),
    sets: list(pdata["steps"]).map((step, i) => stepToSet(i + 1, parseProperties(step["data"]))),
    prescribedSets: list(prescribed["steps"]).map((step, i) => stepToSet(i + 1, parseProperties(step["properties"]))),
    shortName: firstText(act["physicalActivityShortName"], pa["shortName"]),
    activityCode: intOrNull(act["physicalActivityCode"]),
    activityTypeId: text(act["physicalActivityId"]),
    equipmentCode: intOrNull(act["equipmentCode"]),
    targetType: text(act["targetType"]),
    doneAs: text(pa["doneAs"]),
    manuallyDone: Boolean(pa["manuallyDone"]),
    hasAdjustments: Boolean(act["hasAdjustments"]),
    donePartially: Boolean(act["hasBeenDonePartially"]),
    progress: intOrNull(pa["progress"] ?? act["progress"]),
    estimated: {
      duration: act["estimatedDuration"],
      calories: act["estimatedCalories"],
      moves: act["estimatedMove"],
    },
    workloadRanges,
    extData,
  };
}

/** A `GetPerformedWorkoutSessionByIdCr` payload. Exercises never performed are left out. */
export function parseWorkoutSession(data: unknown, sessionId: string): WorkoutSession {
  const d = rec(data);
  const startedOn = text(d["startedOn"]);
  const done = parseProperties(d["doneSummary"]);
  const muscleScores: Record<string, number> = {};
  for (const m of list(d["muscleScores"])) {
    muscleScores[firstText(m["muscleName"], m["muscleType"])] = intOrNull(m["score"]) ?? 0;
  }
  return {
    sessionId,
    date: startedOn.slice(0, 10),
    startedOn,
    closedOn: text(d["closedOn"]),
    name: firstText(d["displayName"], d["name"]),
    type: text(d["sessionType"]),
    status: text(d["workoutSessionStatus"]),
    duration: text(d["displayDurationDoneShort"]),
    durationPlanned: text(d["displayDurationShort"]),
    calories: firstText(done["Calories"]?.formatted, d["displayCaloriesDoneShort"]),
    moves: firstText(done["Move"]?.formatted, d["displayMoveDoneShort"]),
    efficacy: intOrNull(d["workoutEfficacy"]),
    efficacyQuality: text(d["workoutEfficacyQuality"]),
    efficacyDescription: text(d["workoutEfficacyDescription"]),
    muscleScores,
    exercises: list(d["physicalActivities"])
      .filter((a) => rec(a["performedPhysicalActivity"])["id"])
      .map(parseExercise),
    fromTgCoach: Boolean(d["isFromTgCoach"]),
    facilityId: text(d["startedInFacilityId"]),
    userWorkoutSessionId: text(d["userWorkoutSessionId"]),
    clientApplication: text(rec(d["extData"])["mwc_client_application"]),
    doneSummary: done,
  };
}

function parseZones(rows: unknown): HrZone[] {
  return list(rows).map((z) => ({
    name: text(z["name"]),
    lowerBound: numOrNull(z["lowerBound"]),
    upperBound: numOrNull(z["upperBound"]),
    secondsInZone: numOrNull(z["secondsInZone"]) ?? 0,
  }));
}

/**
 * A `CardioLog/{id}/Details` payload. The API spells the block `analitics`; `analytics` is
 * accepted too. Samples with an empty value vector are dropped.
 */
export function parseExerciseAnalytics(data: unknown, analyticsId: string): ExerciseAnalytics {
  const d = rec(data);
  const an = rec(d["analitics"] ?? d["analytics"]);

  const channelByIndex = new Map<number, string>();
  for (const ch of list(an["descriptor"])) {
    const index = intOrNull(ch["i"]);
    if (index === null) continue;
    channelByIndex.set(index, text(rec(ch["pr"])["name"]));
  }
  const channels = [...channelByIndex.entries()].sort(([a], [b]) => a - b).map(([, name]) => name);

  const samples: AnalyticsSample[] = [];
  for (const raw of list(an["samples"])) {
    const vs = Array.isArray(raw["vs"]) ? (raw["vs"] as unknown[]) : [];
    if (vs.length === 0) continue;
    const row: AnalyticsSample = { t: intOrNull(raw["t"]) ?? 0 };
    for (const [index, name] of channelByIndex) row[name] = numOrNull(vs[index]);
    samples.push(row);
  }

  const hr = list(an["hr"])
    .filter((h) => "hr" in h)
    .map((h) => ({ t: intOrNull(h["t"]) ?? 0, hr: intOrNull(h["hr"]) ?? 0 }));

  const laps: Lap[] = list(an["laps"]).map((lap) => ({
    n: intOrNull(lap["n"]),
    lapDistanceM: numOrNull(lap["lapDistance"]),
    lapTimeSec: numOrNull(lap["lapTime"]),
    totalDistanceM: numOrNull(lap["totalDistance"]),
    totalTimeSec: numOrNull(lap["totalTime"]),
  }));

  return {
    analyticsId,
    name: text(d["name"]),
    equipmentType: text(d["equipmentType"]),
    channels,
    samples,
    hr,
    hrZones: parseZones(an["hrZones"]),
    summary: parseProperties(d["data"]),
    date: text(d["date"]),
    target: text(d["target"]),
    activityTypeId: text(d["physicalActivityId"]),
    activityName: text(d["physicalActivityName"]),
    laps,
  };
}

/** A `GetHrSession` payload. */
export function parseHrSession(data: unknown, sessionId: string, date: string): HrSession {
  const d = rec(data);
  return {
    sessionId,
    date,
    summary: parseProperties(d["properties"]),
    hrSamples: list(d["hrSamples"]).map((h) => ({ timestamp: text(h["timestamp"]), hr: intOrNull(h["hr"]) ?? 0 })),
    hrZones: parseZones(d["hrZones"]),
  };
}
