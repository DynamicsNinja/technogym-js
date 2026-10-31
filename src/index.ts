/**
 * An unofficial TypeScript client for the Technogym mywellness API.
 *
 * Exports `TechnogymClient` (sign-in, session and the HTTP transport), `Technogym` (one method
 * per endpoint), the session stores, the `TechnogymError` hierarchy, the response types, the
 * parsers behind every `get*` method, and the analytics helpers (`channelStats`,
 * `segmentAnalytics`, `windowSamples`, `downsample`).
 *
 * ```ts
 * import { FileSessionStore, Technogym, TechnogymClient } from "technogym-js";
 *
 * const client = new TechnogymClient({ sessionStore: new FileSessionStore("./session") });
 * await client.login(email, password);
 *
 * const technogym = new Technogym(client);
 * console.log(await technogym.getRecentWorkouts(7));
 * ```
 *
 * @module
 */
export * from "./errors.js";
export {
  TechnogymClient,
  isAuthErrorEntry,
  type Credentials,
  type ServiceOptions,
  type TechnogymClientOptions,
} from "./client.js";
export { Technogym, type AnalyzedExercise, type ListSessionsOptions } from "./technogym.js";
export {
  FileSessionStore,
  MemorySessionStore,
  type Session,
  type SessionStore,
} from "./auth/session-store.js";
export { APP_ID, APP_NAME, CORE_URL, SERVICES_URL } from "./auth/constants.js";
export type * from "./types.js";
export {
  parseExercise,
  parseExerciseAnalytics,
  parseHrSession,
  parseProperties,
  parseSessionSummary,
  parseUser,
  parseWorkoutSession,
} from "./parse.js";
export {
  CUMULATIVE_CHANNELS,
  SETPOINT_CHANNELS,
  channelStats,
  downsample,
  segmentAnalytics,
  windowSamples,
  type ChannelStats,
  type CumulativeDelta,
  type Segment,
  type SegmentBy,
  type SegmentMode,
  type SegmentOptions,
} from "./analysis.js";
