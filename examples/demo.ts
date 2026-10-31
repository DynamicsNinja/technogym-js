/**
 * `npm run demo`: prints the last 30 days of sessions, the newest session's exercises and, when it
 * has a cardio exercise, that exercise's intervals. Run `npm run login` first.
 */
import { FileSessionStore, Technogym, TechnogymClient } from "../src/index.js";

const client = new TechnogymClient({ sessionStore: new FileSessionStore("./session") });
if (!(await client.loadSession())) {
  console.error("No saved session: run `npm run login` first.");
  process.exit(1);
}
const technogym = new Technogym(client);

const user = await technogym.getUser();
console.log(`${user.firstName} ${user.lastName}, Movergy ${await technogym.getMovergy()}`);

const today = new Date();
const monthAgo = new Date(today.getTime() - 30 * 86_400_000);
const sessions = await technogym.listSessions(monthAgo, today);
console.table(sessions.map((s) => ({ id: s.sessionId, date: s.date, time: s.time, name: s.name, min: s.durationMin, moves: s.moves })));

const latest = sessions[0];
if (!latest) process.exit(0);

const detail = await technogym.getWorkoutSession(latest.sessionId, latest.date);
console.log(`\n${detail.name} on ${detail.date}: ${detail.duration}, ${detail.calories}, efficacy ${detail.efficacy}`);
for (const ex of detail.exercises) {
  const sets = ex.sets.map((s) => `${s.reps ?? "?"}x${s.weightKg ?? "?"}kg`).join(", ");
  console.log(`  ${ex.name} (${ex.machine})${sets ? `: ${sets}` : ""}`);
}

const cardio = detail.exercises.find((ex) => ex.isCardio && ex.analyticsId);
if (cardio) {
  const analyzed = await technogym.analyzeExercise(cardio.analyticsId);
  console.log(`\n${cardio.name}: ${analyzed.segments.length} ${analyzed.segmentMode} segments`);
  console.table(
    analyzed.segments.map((s) => ({ from: s.startSec, to: s.endSec, setpoint: JSON.stringify(s.setpoint ?? {}), pace: s.paceMinPerKm })),
  );
}
