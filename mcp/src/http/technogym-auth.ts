/** Every mywellness call the OAuth server makes, behind one interface so tests can fake the login. */
import { Technogym, TechnogymAuthError, TechnogymClient, type Session, type TechnogymClientOptions } from "technogym-js";

export interface TechnogymAuth {
  /** Signs in; the session (bearer token and account) is sealed into the OAuth tokens, never stored. */
  login(email: string, password: string): Promise<Session>;
  /**
   * The session with a fresh token. A mywellness token lives one hour and every authenticated
   * response hands back a renewed one, so one cheap call while the token is still valid extends
   * it. Throws `TechnogymAuthError` once the token has expired.
   */
  refresh(session: Session): Promise<Session>;
}

export function technogymAuth(options: Omit<TechnogymClientOptions, "sessionStore" | "credentials"> = {}): TechnogymAuth {
  return {
    async login(email, password) {
      // A fresh client per sign-in: the in-memory credentials `login()` keeps die with it.
      return new TechnogymClient(options).login(email, password);
    },
    async refresh(session) {
      const client = new TechnogymClient(options);
      client.setSession(session);
      await new Technogym(client).getMovergy();
      return client.getSession() ?? session;
    },
  };
}

/**
 * mywellness has ended the session: a 401/403 or an auth error in the response envelope. There is
 * no refresh token behind it, so the connection is over and the user reconnects.
 */
export function isDeadSession(error: unknown): boolean {
  return error instanceof TechnogymAuthError;
}
