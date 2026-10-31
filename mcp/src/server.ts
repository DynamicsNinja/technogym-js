import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TechnogymAuthError } from "technogym-js";
import { errorResult } from "./errors.js";
import type { Session } from "./session.js";
import { buildTools } from "./tools.js";

const INSTRUCTIONS =
  "Read-only access to the user's Technogym mywellness training history: workout sessions, " +
  "per-exercise data with per-set reps/weight, per-second exercise analytics and whole-session heart " +
  "rate. Dates are ISO (YYYY-MM-DD). A session is identified by session_id plus its date. Start with " +
  "get_workout_sessions or get_recent_workouts, then get_workout_session for exercises and sets. " +
  "Session/exercise summaries are averages and maxima only: for intervals, per-km splits and " +
  "per-second speed / cadence / power / grade call get_exercise_analytics with the exercise's " +
  "analyticsId; zoom into one interval with from_sec/to_sec and sample_every_seconds=1 (and " +
  "get_session_heart_rate for the HR trace).";

export function createServer(session: Session, version = "0.0.0"): Server {
  const tools = buildTools(session);
  const byName = new Map(tools.map((def) => [def.tool.name, def]));
  const server = new Server(
    { name: "technogym-mcp", title: "Technogym mywellness (unofficial)", version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => t.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const def = byName.get(request.params.name);
    if (!def) return errorResult(new Error(`Unknown tool "${request.params.name}"`));
    try {
      return await def.run(request.params.arguments ?? {});
    } catch (error) {
      // A login made in a terminal since must be picked up by the next call.
      if (error instanceof TechnogymAuthError) session.reset();
      return errorResult(error);
    }
  });
  return server;
}
