/**
 * `npm run login [dir]`: signs in with TECHNOGYM_EMAIL / TECHNOGYM_PASSWORD from .env and saves the
 * session to `dir` (default ./session) for `npm run demo`.
 */
import { FileSessionStore, TechnogymClient } from "../src/index.js";

process.loadEnvFile?.(".env");
const email = process.env["TECHNOGYM_EMAIL"];
const password = process.env["TECHNOGYM_PASSWORD"];
if (!email || !password) {
  console.error("Set TECHNOGYM_EMAIL and TECHNOGYM_PASSWORD in .env (see .env.example).");
  process.exit(1);
}

const dir = process.argv[2] ?? "./session";
const client = new TechnogymClient({ sessionStore: new FileSessionStore(dir) });
const session = await client.login(email, password);
console.log(`Logged in as ${session.user.firstName} ${session.user.lastName} (user ${session.user.userId}).`);
console.log(`Facilities: ${session.user.facilities.map((f) => `${f.name} [${f.url}]`).join(", ") || "none"}`);
console.log(`Session saved to ${dir}.`);
