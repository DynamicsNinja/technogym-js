/**
 * Parsed shapes of mywellness responses. Every parsed object has a `*Raw` twin method on
 * `Technogym` that returns the untouched payload, for anything these types do not model.
 *
 * Localised strings (exercise names, units, `formatted` values) come back in the account's culture.
 */

/** A gym the account belongs to. `url` is the slug every training endpoint path starts with. */
export interface Facility {
  id: string;
  url: string;
  name: string;
}

/** The signed-in account, from the login response's `userContext` and `facilities`. */
export interface UserInfo {
  userId: string;
  firstName: string;
  lastName: string;
  nickName: string;
  /** e.g. `Metric`. */
  measurementSystem: string;
  /** e.g. `nb-NO`; localised strings in every response follow it. */
  culture: string;
  facilities: Facility[];
}

/**
 * One measured or prescribed property, normalised from mywellness's two row shapes. `value` is in
 * the API's base unit (seconds, metres, kg), `displayValue` is in `unit` (the unit the console shows),
 * and `formatted` is the localised display string. On CardioLog rows `value` and `displayValue`
 * are the same number.
 */
export interface Property {
  value: unknown;
  displayValue: unknown;
  unit: string;
  formatted: unknown;
}

/** Properties keyed by their mywellness name (`Calories`, `AvgSpeed`, `IsoWeight`, ...). */
export type PropertyMap = Record<string, Property>;

/** A row of `listSessions`. `sessionId` and `date` together address the session's detail calls. */
export interface SessionSummary {
  /** The session's `idCr`. */
  sessionId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`, local to the gym. */
  time: string;
  name: string;
  /** `WorkoutSession`, `HRWorkout`, ... */
  type: string;
  durationMin: number | null;
  moves: number | null;
  calories: number | null;
  exercisesDone: number | null;
  exercisesPlanned: number | null;
  userWorkoutSessionId: string;
  facilityId: string;
  workoutEffectiveness: number | null;
  workoutCompliance: number | null;
}

/** One performed or prescribed set of an exercise. */
export interface SetData {
  /** 1-based. */
  setNumber: number;
  /** `IsoReps`, else `Reps`. */
  reps: number | null;
  /** `IsoWeight`, else `Weight`. */
  weightKg: number | null;
  restSec: number | null;
  durationSec: number | null;
  /** Every raw property of the step. */
  properties: PropertyMap;
}

/** Allowed workload range for one property on this machine. */
export interface WorkloadRange {
  min: unknown;
  max: unknown;
  step: unknown;
  readOnly: boolean;
  visibility: unknown;
}

/** One exercise of a workout session. */
export interface Exercise {
  /** `performedPhysicalActivity.id`. */
  activityId: string;
  /** Pass to `getExerciseAnalytics` for the per-second data. */
  analyticsId: string;
  name: string;
  /** The equipment's name, e.g. `Leg press #40`. */
  machine: string;
  equipmentType: string;
  /** `StrengthLoad`, `Cardio`, ... (`physicalActivityType`). */
  type: string;
  isCardio: boolean;
  status: string;
  doneOn: string;
  position: number | null;
  /** Localised display strings, e.g. `6 min.`. */
  duration: string;
  calories: string;
  moves: string;
  muscles: string[];
  /**
   * Every summary property the machine reported (cardio: AvgSpeed, AvgRunningCadence,
   * AvgRunningPower, Pace...; strength: Rm1, TotalIsoWeight...).
   */
  summary: PropertyMap;
  sets: SetData[];
  prescribedSets: SetData[];
  shortName: string;
  activityCode: number | null;
  activityTypeId: string;
  equipmentCode: number | null;
  /** What the exercise was set to: `Duration`, `Distance`, `Calories`, ... */
  targetType: string;
  /** `Added`, `Prescribed`, ... */
  doneAs: string;
  manuallyDone: boolean;
  hasAdjustments: boolean;
  donePartially: boolean;
  progress: number | null;
  /** Prescribed or estimated figures, to compare with what was done. */
  estimated: { duration: unknown; calories: unknown; moves: unknown };
  workloadRanges: Record<string, WorkloadRange>;
  /** Non-empty console `extData`, with the `mwc_` prefix removed. */
  extData: Record<string, unknown>;
}

/** Full detail of one workout session. */
export interface WorkoutSession {
  sessionId: string;
  /** `YYYY-MM-DD`, from `startedOn`. */
  date: string;
  startedOn: string;
  closedOn: string;
  name: string;
  type: string;
  status: string;
  duration: string;
  durationPlanned: string;
  calories: string;
  moves: string;
  efficacy: number | null;
  efficacyQuality: string;
  efficacyDescription: string;
  /** Muscle name to score. */
  muscleScores: Record<string, number>;
  /** Only exercises that were performed. */
  exercises: Exercise[];
  fromTgCoach: boolean;
  facilityId: string;
  userWorkoutSessionId: string;
  clientApplication: string;
  /** Every session-level total. */
  doneSummary: PropertyMap;
}

export interface HrZone {
  name: string;
  lowerBound: number | null;
  upperBound: number | null;
  secondsInZone: number;
}

/** One second of an exercise: `t` plus one value per machine channel (`Speed`, `Power`, ...). */
export interface AnalyticsSample {
  t: number;
  [channel: string]: number | null;
}

/** A console auto-lap (every km on a treadmill). */
export interface Lap {
  n: number | null;
  lapDistanceM: number | null;
  lapTimeSec: number | null;
  totalDistanceM: number | null;
  totalTimeSec: number | null;
}

/** Per-second analytics of one exercise: machine channels, heart rate and laps. */
export interface ExerciseAnalytics {
  analyticsId: string;
  name: string;
  equipmentType: string;
  /** Channel names in descriptor order. Strength machines have none. */
  channels: string[];
  samples: AnalyticsSample[];
  hr: { t: number; hr: number }[];
  hrZones: HrZone[];
  summary: PropertyMap;
  /** As the API formats it, e.g. `09.09.2026`. */
  date: string;
  target: string;
  activityTypeId: string;
  activityName: string;
  laps: Lap[];
}

/** The whole-session heart-rate trace. */
export interface HrSession {
  sessionId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Duration, avg/min/max HR, calories, MOVEs, METs. */
  summary: PropertyMap;
  hrSamples: { timestamp: string; hr: number }[];
  hrZones: HrZone[];
}

/** A raw payload, passed through untouched. */
export type RawPayload = Record<string, unknown>;
