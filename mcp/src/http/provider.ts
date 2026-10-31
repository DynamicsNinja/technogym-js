/**
 * The hosted OAuth 2.1 authorization server, as the MCP SDK's `OAuthServerProvider`. Nothing the
 * client receives is stored: client ids, sign-in form state, codes and tokens are sealed. The
 * grant table only makes codes single-use, rotates refresh tokens, and allows revocation.
 *
 * mywellness has no refresh token. Its bearer token lives one hour and is renewed by using it, so
 * each OAuth refresh makes one cheap mywellness call and seals the renewed token. Access tokens
 * last 20 minutes, so a client in use refreshes well inside mywellness's hour. After an hour with
 * no refresh the mywellness token is gone: the refresh fails, the grant is revoked and the user
 * reconnects.
 */
import type { Response } from "express";
import { InvalidGrantError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { TechnogymAuthError, TechnogymError, TechnogymRateLimitError, type Session as TgSession } from "technogym-js";
import { isDeadSession, type TechnogymAuth } from "./technogym-auth.js";
import { checkGeneration, type GrantStore } from "./grants.js";
import { credentialsPage, errorPage, isTrustedRedirect, pageHeaders, redirectTarget } from "./pages.js";
import type { Sealer } from "./seal.js";

/** Well inside the one hour a mywellness token lives, so a refresh renews it before it expires. */
export const ACCESS_TTL_S = 20 * 60;
export const CODE_TTL_S = 60;
export const FORM_TTL_S = 600;
export const TOUCH_EVERY_S = 60;

interface AuthRequest {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
}
interface CodePayload {
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  session: TgSession;
}
interface AccessPayload {
  grantId: string;
  clientId: string;
  session: TgSession;
}
interface RefreshPayload extends AccessPayload {
  generation: number;
}
export interface AccessExtra {
  grantId: string;
  /** The grant's person pseudonym, so request logs can group a person's connections. */
  userHash: string;
  session: TgSession;
}

export interface ProviderOptions {
  sealer: Sealer;
  grants: GrantStore;
  auth: TechnogymAuth;
  /** Where the sign-in form posts. */
  signInPath: string;
  now?: () => number;
  /** Operational log lines; never given emails, passwords or tokens. */
  log?: (line: Record<string, unknown>) => void;
}

export type SignInOutcome =
  | { kind: "redirect"; location: string }
  | { kind: "page"; status: number; headers: Record<string, string>; body: string };

const EXPIRED = "This sign-in page has expired. Start again from your MCP client (remove and re-add the connector if needed).";

/**
 * Only what the tools need goes into the sealed tokens: the bearer token and the account. Every
 * OAuth token carries this, so it stays small.
 */
const slim = (s: TgSession): TgSession => ({ token: s.token, user: s.user, savedAt: s.savedAt });

function signInError(error: unknown): string {
  if (error instanceof TechnogymRateLimitError) return "mywellness is limiting sign-ins right now. Wait a few minutes and try again.";
  if (error instanceof TechnogymAuthError) return "mywellness didn't accept that email and password.";
  if (error instanceof TechnogymError) return `Sign-in failed: ${error.message}`;
  return "Something went wrong signing you in. Try again in a minute.";
}

export class HostedOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly #sealer: Sealer;
  readonly #grants: GrantStore;
  readonly #auth: TechnogymAuth;
  readonly #signInPath: string;
  readonly #now: () => number;
  readonly #log: (line: Record<string, unknown>) => void;

  constructor(options: ProviderOptions) {
    this.#sealer = options.sealer;
    this.#grants = options.grants;
    this.#auth = options.auth;
    this.#signInPath = options.signInPath;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#log = options.log ?? (() => {});
    this.clientsStore = {
      getClient: (clientId) => {
        const sealed = this.#sealer.unseal<Omit<OAuthClientInformationFull, "client_id">>("client", clientId);
        return sealed ? { ...sealed.data, client_id: clientId } : undefined;
      },
      // The whole registration (including a confidential client's secret) is sealed into the id.
      registerClient: (client) => {
        const info = { ...client, client_id_issued_at: this.#now() };
        return { ...info, client_id: this.#sealer.seal("client", info) };
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const request: AuthRequest = {
      clientId: client.client_id,
      clientName: client.client_name ?? null,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      ...(params.state !== undefined && { state: params.state }),
    };
    res
      .status(200)
      .set(pageHeaders(params.redirectUri))
      .send(credentialsPage({ action: this.#signInPath, request: this.#sealer.seal("authreq", request, FORM_TTL_S), clientName: request.clientName, redirectUri: request.redirectUri }));
  }

  /** The sign-in form's POST. */
  async handleSignIn(form: Record<string, string | undefined>): Promise<SignInOutcome> {
    const sealedRequest = form["request"];
    const unsealed = this.#sealer.unseal<AuthRequest>("authreq", sealedRequest);
    if (!unsealed) return this.#page(undefined, errorPage(EXPIRED), 400);
    const request = unsealed.data;
    const email = (form["email"] ?? "").trim();
    const password = form["password"] ?? "";
    const retry = (error: string) =>
      this.#page(request, credentialsPage({ action: this.#signInPath, request: sealedRequest!, clientName: request.clientName, redirectUri: request.redirectUri, email, error }), 400);
    if (!email || !password) return retry("Enter your mywellness email and password.");
    // Enforced here, before mywellness is called.
    if (!isTrustedRedirect(request.redirectUri) && form["confirmRedirect"] !== "1") {
      return retry(`Tick the box to confirm you trust ${redirectTarget(request.redirectUri)} before signing in.`);
    }
    const started = performance.now();
    try {
      const session = await this.#auth.login(email, password);
      const outcome = this.#finish(request, slim(session), form["disconnectOthers"] === "1");
      this.#log({ msg: "sign-in", ms: Math.round(performance.now() - started), ok: true });
      return outcome;
    } catch (error) {
      if (error instanceof TechnogymRateLimitError) this.#log({ msg: "mywellness rate limited" });
      this.#log({ msg: "sign-in", ms: Math.round(performance.now() - started), ok: false });
      return retry(signInError(error));
    }
  }

  #finish(request: AuthRequest, session: TgSession, disconnectOthers: boolean): SignInOutcome {
    const userHash = this.#sealer.pseudonym(session.user.userId);
    const grant = this.#grants.create(userHash, request.clientName, this.#now());
    if (disconnectOthers) this.#grants.revokeUser(userHash, grant.grantId);
    const code: CodePayload = { grantId: grant.grantId, clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, session };
    const location = new URL(request.redirectUri);
    location.searchParams.set("code", this.#sealer.seal("code", code, CODE_TTL_S));
    if (request.state !== undefined) location.searchParams.set("state", request.state);
    return { kind: "redirect", location: location.href };
  }

  #page(request: AuthRequest | undefined, body: string, status = 200): SignInOutcome {
    return { kind: "page", status, headers: pageHeaders(request?.redirectUri), body };
  }

  #code(client: OAuthClientInformationFull, code: string): CodePayload {
    const sealed = this.#sealer.unseal<CodePayload>("code", code);
    if (!sealed || sealed.data.clientId !== client.client_id) throw new InvalidGrantError("The authorization code is invalid or has expired");
    return sealed.data;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.#code(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const payload = this.#code(client, code);
    if (redirectUri !== undefined && redirectUri !== payload.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (!this.#grants.activate(payload.grantId, this.#now())) {
      // A replayed code: revoke what the first exchange issued (RFC 6749 §4.1.2).
      if (this.#grants.get(payload.grantId)?.state === "active") this.#grants.revoke(payload.grantId);
      throw new InvalidGrantError("The authorization code has already been used");
    }
    return this.#issue(payload.grantId, client.client_id, 0, payload.session);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const sealed = this.#sealer.unseal<RefreshPayload>("refresh", refreshToken);
    if (!sealed || sealed.data.clientId !== client.client_id) throw new InvalidGrantError("The refresh token is invalid");
    const { grantId, generation, session } = sealed.data;
    const verdict = checkGeneration(this.#grants.get(grantId), generation, this.#now());
    if (verdict === "missing" || verdict === "revoked") throw new InvalidGrantError("This connection was disconnected; sign in again");
    if (verdict === "reused") {
      this.#grants.revoke(grantId);
      throw new InvalidGrantError("This refresh token was already used, so the connection was disconnected for safety; sign in again");
    }
    let renewed: TgSession;
    try {
      renewed = slim(await this.#auth.refresh(session));
    } catch (error) {
      if (isDeadSession(error)) {
        this.#grants.revoke(grantId);
        throw new InvalidGrantError("Your mywellness session ended after an hour without use; sign in again");
      }
      throw new ServerError("mywellness could not renew the session right now; try again shortly");
    }
    const rotated = this.#grants.rotate(grantId, generation, this.#now());
    if (!rotated.ok) throw new InvalidGrantError("This connection was disconnected; sign in again");
    return this.#issue(grantId, client.client_id, rotated.generation, renewed);
  }

  #issue(grantId: string, clientId: string, generation: number, session: TgSession): OAuthTokens {
    return {
      access_token: this.#sealer.seal("access", { grantId, clientId, session } satisfies AccessPayload, ACCESS_TTL_S),
      token_type: "bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: this.#sealer.seal("refresh", { grantId, clientId, generation, session } satisfies RefreshPayload),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const sealed = this.#sealer.unseal<AccessPayload>("access", token);
    if (!sealed || sealed.exp === undefined) throw new InvalidTokenError("The access token is invalid or has expired");
    const grant = this.#grants.get(sealed.data.grantId);
    if (grant?.state !== "active") throw new InvalidTokenError("This connection was disconnected");
    const now = this.#now();
    if (now - grant.lastUsed >= TOUCH_EVERY_S) this.#grants.touch(grant.grantId, now);
    const extra: AccessExtra = { grantId: grant.grantId, userHash: grant.userHash, session: sealed.data.session };
    return { token, clientId: sealed.data.clientId, scopes: [], expiresAt: sealed.exp, extra: { ...extra } };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const found = this.#sealer.unseal<AccessPayload>("access", request.token) ?? this.#sealer.unseal<RefreshPayload>("refresh", request.token);
    if (found && found.data.clientId === client.client_id) this.#grants.revoke(found.data.grantId);
  }
}
