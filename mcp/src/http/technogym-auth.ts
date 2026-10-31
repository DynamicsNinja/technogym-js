/** Every mywellness call the OAuth server makes, behind one interface so tests can fake the login. */
import { TechnogymAuthError, TechnogymClient, type Session, type TechnogymClientOptions } from "technogym-js";

export interface TechnogymAuth {
  /** Signs in; the session (bearer token and account) is sealed into the OAuth tokens, never stored. */
  login(email: string, password: string): Promise<Session>;
}

export function technogymAuth(options: Omit<TechnogymClientOptions, "sessionStore" | "credentials"> = {}): TechnogymAuth {
  return {
    async login(email, password) {
      // A fresh client per sign-in: the in-memory credentials `login()` keeps die with it.
      return new TechnogymClient(options).login(email, password);
    },
  };
}

/**
 * mywellness has ended the session: a 401/403 or an auth error in the response envelope. Unlike
 * Garmin there is no refresh token to try, so the connection is over and the user reconnects.
 */
export function isDeadSession(error: unknown): boolean {
  return error instanceof TechnogymAuthError;
}
