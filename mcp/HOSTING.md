# Hosting the MCP server

Operator runbook for the hosted server at `https://technogym.ficdev.xyz/mcp`. Users do not need
this; see [README.md](README.md). The code is in `src/http/`, the image is built by
`mcp/Dockerfile`, and the bundle is `dist-http/http.mjs`. It is not published to npm.

## How it works

Each user adds the server as a connector (claude.ai: Settings → Connectors → Add custom connector,
URL `https://technogym.ficdev.xyz/mcp`) and signs in with their own mywellness email and password
on the server's sign-in page. The password goes to mywellness only and is never stored. The
mywellness bearer token is sealed (AES-256-GCM, `SEAL_KEYS`) into the OAuth tokens the client
holds; the SQLite grant table holds no token, no email and no mywellness id (only a keyed
pseudonym), and exists so codes are single-use, refresh tokens rotate, and connections can be
revoked.

mywellness has no refresh token. Its bearer token lives until mywellness rejects it; then the
grant is revoked and the user is told to reconnect. A 5xx or a timeout never revokes.

```
technogym.ficdev.xyz ── Cloudflare tunnel ── Traefik (Dokploy)
   ├─ /mcp…                                   → technogym-mcp container
   ├─ /.well-known/oauth-protected-resource…  → same container
   └─ /.well-known/oauth-authorization-server → same container
```

The server needs Node 22.13 or newer (`node:sqlite`). The image provides it.

## Dokploy setup

1. Application in project `technogym`. Source: GitHub `DynamicsNinja/technogym-js`, branch
   `main`, build type Dockerfile, Dockerfile path `mcp/Dockerfile`, build context `.`.
2. Environment: `PUBLIC_URL=https://technogym.ficdev.xyz`, `SEAL_KEYS=<openssl rand -base64 32>`,
   `DB_PATH=/data/grants.db`, `PORT=3000`, `TRUST_PROXY=1`, `CLIENT_IP_HEADER=cf-connecting-ip`.
   `CLIENT_IP_HEADER` is safe only because the host is reachable solely through the Cloudflare
   tunnel; without it every per-IP limit would key on the tunnel and become global.
3. Mount: a **named volume** at `/data` (not a bind mount; see the Dockerfile comment).
4. Three domains, host `technogym.ficdev.xyz`, container port 3000, **Strip Path off**: paths
   `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`.
   HTTPS is terminated by Cloudflare, as for garmin.ficdev.xyz.
5. Cloudflare tunnel: `technogym.ficdev.xyz` must route to Traefik like `garmin.ficdev.xyz` does.
6. Auto Deploy on `main`: run `npm run check` before pushing.
7. Check: `curl https://technogym.ficdev.xyz/mcp/healthz` returns `ok`, and
   `curl -i -X POST https://technogym.ficdev.xyz/mcp` returns `401` with a `resource_metadata` header.

## Operations

- **Revoke one connection:** `node http.mjs revoke <grant_id>` in the container (Dokploy:
  Terminal). Logs carry only the first 8 characters; look the full id up with
  `node --experimental-sqlite -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/data/grants.db').prepare('SELECT grant_id, client_name, state FROM grants WHERE grant_id LIKE ?').all(process.argv[1]+'%'))" <prefix>`.
- **Revoke everyone:** `node http.mjs revoke --all`.
- **Rotate the key:** prepend a new key to `SEAL_KEYS` and redeploy. The first key seals; every
  key unseals. Keep old keys: sealed client ids never expire and only unseal under their key.
- **Logs** are JSON lines (grant prefix, person prefix, RPC method, tool, status, ms; never tokens,
  emails, passwords or payloads) on stdout and in `/data/logs/YYYY-MM.jsonl`.

## Known risks

Every user's mywellness traffic, logins included, leaves from one server IP. In place: five failed
sign-ins per IP and 100 in total per 15 minutes, 120 MCP requests per connection per minute, and
plain-language errors on a 429. The client headers mimic Technogym's own web app, so a change on
their side breaks sign-in for everyone at once.
