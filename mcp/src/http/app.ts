/**
 * The hosted server's HTTP surface. Traefik sends it `/mcp…` and the two OAuth `/.well-known`
 * documents. The OAuth endpoints are the SDK's own handlers, mounted under /mcp/oauth.
 */
import { isIP } from "node:net";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { TechnogymClientOptions } from "technogym-js";
import { buildTools, serverForTools } from "../server.js";
import type { GrantStore } from "./grants.js";
import { errorPage, pageHeaders } from "./pages.js";
import { HostedOAuthProvider, type AccessExtra } from "./provider.js";
import { requestSession } from "./request-session.js";
import type { Sealer } from "./seal.js";
import { buildStats, statsHeaders, statsPage, TREND_DAYS, type Stats } from "./stats.js";
import { isDeadSession, type TechnogymAuth } from "./technogym-auth.js";
import { ToolUsage } from "./tool-usage.js";

export interface HttpAppDeps {
  publicUrl: URL;
  sealer: Sealer;
  grants: GrantStore;
  auth: TechnogymAuth;
  version: string;
  trustProxy?: boolean;
  /** Header holding the real client IP (e.g. cf-connecting-ip); see the middleware in createHttpApp. */
  clientIpHeader?: string | null;
  technogymClient?: Omit<TechnogymClientOptions, "sessionStore" | "credentials">;
  log?: (line: Record<string, unknown>) => void;
  /** The month log files; the stats page counts people who called a tool from them. Without it, no one is active. */
  logDir?: string;
  now?: () => number;
}

const DOCS = "https://github.com/DynamicsNinja/technogym-js/tree/main/mcp#readme";
const SIGN_IN_PATH = "/mcp/oauth/signin";

const accessOf = (req: Request): AccessExtra => {
  const extra = req.auth?.extra as AccessExtra | undefined;
  if (!extra) throw new Error("request reached /mcp without authentication");
  return extra;
};

/** Only the JSON-RPC method and tool name are logged: never arguments, results or tokens. */
function describeRpc(body: unknown): { rpc?: string; tool?: string } {
  const msg: unknown = Array.isArray(body) ? (body as unknown[])[0] : body;
  if (typeof msg !== "object" || msg === null) return {};
  const { method, params } = msg as { method?: unknown; params?: { name?: unknown } };
  return {
    ...(typeof method === "string" && { rpc: method }),
    ...(method === "tools/call" && typeof params?.name === "string" && { tool: params.name }),
  };
}

export function createHttpApp(deps: HttpAppDeps): Express {
  const base = new URL(deps.publicUrl.origin);
  const at = (p: string) => new URL(p, base).href;
  const log = deps.log ?? ((line) => console.log(JSON.stringify({ t: new Date().toISOString(), ...line })));
  const provider = new HostedOAuthProvider({ sealer: deps.sealer, grants: deps.grants, auth: deps.auth, signInPath: SIGN_IN_PATH, now: deps.now, log });
  const metadata: OAuthMetadata = {
    issuer: base.href,
    service_documentation: DOCS,
    authorization_endpoint: at("/mcp/oauth/authorize"),
    token_endpoint: at("/mcp/oauth/token"),
    registration_endpoint: at("/mcp/oauth/register"),
    revocation_endpoint: at("/mcp/oauth/revoke"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post"],
  };

  const session = requestSession(deps.technogymClient);
  const tools = buildTools(session);

  const app = express();
  app.disable("x-powered-by");
  if (deps.trustProxy) app.set("trust proxy", 1);
  if (deps.clientIpHeader) {
    const header = deps.clientIpHeader;
    // Only safe when the container is reachable solely through the proxy that sets this header
    // (e.g. a Cloudflare Tunnel); otherwise a client can forge it. Installed before every limiter,
    // so ours and the SDK handlers' per-IP limits all key on the real client.
    app.use((req, _res, next) => {
      const value = req.headers[header];
      const ip = typeof value === "string" ? value.trim() : "";
      if (isIP(ip) !== 0) Object.defineProperty(req, "ip", { value: ip, configurable: true, enumerable: true });
      next();
    });
  }

  app.get("/mcp/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  // Public usage counts. Rebuilt at most every five minutes, so a busy page costs the database nothing.
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let stats: { at: number; value: Stats } | null = null;
  const usage = new ToolUsage(deps.logDir ?? "", () => deps.grants.owners(), TREND_DAYS);
  const currentStats = () => {
    const t = now();
    if (!stats || t - stats.at >= 300) stats = { at: t, value: buildStats(deps.grants, usage, t) };
    return stats.value;
  };
  const statsLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false });
  app.get("/mcp/stats", statsLimit, (_req, res) => {
    res.set(statsHeaders()).send(statsPage(currentStats()));
  });
  app.get("/mcp/stats.json", statsLimit, (_req, res) => {
    res.set("cache-control", "public, max-age=300").json(currentStats());
  });

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: metadata,
      resourceServerUrl: new URL("/mcp", base),
      resourceName: "Technogym mywellness (unofficial)",
      serviceDocumentationUrl: new URL(DOCS),
    }),
  );
  const small = [express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" })];
  app.use("/mcp/oauth/authorize", small, authorizationHandler({ provider, rateLimit: { windowMs: 60_000, limit: 60 } }));
  // claude.ai registers clients and exchanges tokens from Anthropic's servers, so these per-IP
  // limits are shared by every claude.ai user: they only stop a runaway client.
  app.use("/mcp/oauth/token", small, tokenHandler({ provider, rateLimit: { windowMs: 60_000, limit: 300 } }));
  app.use(
    "/mcp/oauth/register",
    small,
    // A client_id is never re-issued, so a confidential client's secret must not expire (0 = never).
    clientRegistrationHandler({
      clientsStore: provider.clientsStore,
      clientIdGeneration: false,
      clientSecretExpirySeconds: 0,
      rateLimit: { windowMs: 3_600_000, limit: 1000 },
    }),
  );
  app.use("/mcp/oauth/revoke", small, revocationHandler({ provider }));

  // Five failed tries per IP per 15 min, and 100 tries across all IPs, also protect the server
  // IP's standing with mywellness, which sees every user's login come from here.
  const tooMany = (message: string): RequestHandler => (_req, res) => {
    res.status(429).set(pageHeaders()).send(errorPage(message));
  };
  const signInLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: tooMany("Too many sign-in attempts from your network. Wait 15 minutes and try again."),
  });
  const globalSignInLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 100,
    keyGenerator: () => "global",
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: tooMany("Too many people are signing in right now. Wait 15 minutes and try again."),
  });
  app.post(SIGN_IN_PATH, signInLimit, globalSignInLimit, express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    const outcome = await provider.handleSignIn((req.body ?? {}) as Record<string, string | undefined>);
    if (outcome.kind === "redirect") res.redirect(302, outcome.location);
    else res.status(outcome.status).set(outcome.headers).send(outcome.body);
  });

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: at("/.well-known/oauth-protected-resource/mcp") });
  const perGrant = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false, keyGenerator: (req) => accessOf(req).grantId });
  const handleMcp: RequestHandler = async (req, res) => {
    const { grantId, userHash, session: tgSession } = accessOf(req);
    const started = Date.now();
    const server = serverForTools(tools, session, deps.version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    res.on("finish", () => log({ grant: grantId.slice(0, 8), user: userHash.slice(0, 8), ...describeRpc(req.body), status: res.statusCode, ms: Date.now() - started }));
    await server.connect(transport);
    const onRejected = (error: unknown) => {
      if (isDeadSession(error)) deps.grants.revoke(grantId);
    };
    await session.run({ grantId, session: tgSession, onRejected }, () => transport.handleRequest(req, res, req.body));
  };
  app.post("/mcp", bearer, perGrant, express.json({ limit: "1mb" }), handleMcp);

  const notAllowed: RequestHandler = (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  return app;
}
