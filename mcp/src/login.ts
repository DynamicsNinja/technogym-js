import { createInterface } from "node:readline/promises";

export interface LoginIo {
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
}

/** Credentials from the environment, else asked for on the terminal. */
export async function askCredentials(
  io: LoginIo,
  env: Record<string, string | undefined> = process.env,
): Promise<{ email: string; password: string }> {
  const email = (env["TECHNOGYM_EMAIL"]?.trim() || (await io.ask("mywellness email: "))).trim();
  const password = env["TECHNOGYM_PASSWORD"] || (await io.askHidden("mywellness password: "));
  if (!email || !password) throw new Error("Email and password are required.");
  return { email, password };
}

/** Prompts on stderr, so stdout stays clean for MCP frames even here. */
export function terminalIo(): LoginIo {
  return {
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    askHidden(question) {
      return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        process.stderr.write(question);
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let value = "";
        const done = (error?: Error) => {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          if (error) reject(error);
          else resolve(value);
        };
        const onData = (chunk: string) => {
          for (const ch of chunk) {
            if (ch === "\r" || ch === "\n") return done();
            if (ch === "\u0003") return done(new Error("Cancelled."));
            if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
            else value += ch;
          }
        };
        stdin.on("data", onData);
      });
    },
  };
}
