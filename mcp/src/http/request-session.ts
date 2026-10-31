/**
 * The hosted server's `Session`: tools are built once, and each HTTP request runs inside its own
 * AsyncLocalStorage context carrying that user's mywellness session (unsealed from the access token).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Technogym, TechnogymClient, type Session as TgSession, type TechnogymClientOptions } from "technogym-js";
import type { Session } from "../session.js";

export interface RequestContext {
  grantId: string;
  session: TgSession;
  onRejected(error: unknown): void;
}

export const RECONNECT_HINT =
  "reconnect the Technogym connector in your MCP client (in claude.ai: Settings → Connectors), then try again";

export interface RequestSession extends Session {
  run<T>(context: RequestContext, fn: () => Promise<T>): Promise<T>;
}

export function requestSession(clientOptions: Omit<TechnogymClientOptions, "sessionStore" | "credentials"> = {}): RequestSession {
  const storage = new AsyncLocalStorage<{ context: RequestContext; api?: Technogym }>();
  return {
    loginHint: RECONNECT_HINT,
    run: (context, fn) => storage.run({ context }, fn),
    async get() {
      const store = storage.getStore();
      if (!store) throw new Error("No mywellness connection for this request");
      if (!store.api) {
        const client = new TechnogymClient(clientOptions);
        client.setSession(store.context.session);
        store.api = new Technogym(client);
      }
      return store.api;
    },
    reset(options) {
      if (options?.rejected) storage.getStore()?.context.onRejected(options.error);
    },
  };
}
