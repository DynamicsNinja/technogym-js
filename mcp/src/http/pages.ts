/** The hosted sign-in pages, posting to /mcp/oauth/signin. */
import { createHash } from "node:crypto";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

const REPO_URL = "https://github.com/DynamicsNinja/technogym-js";

/**
 * The one script the pages run: on submit it blocks a second submit (a second login is a second
 * try against mywellness) and shows that something is happening. The pages work without it. When
 * the browser restores the page from its back/forward cache the form is reset, never reloaded.
 */
export const SUBMIT_SCRIPT =
  'document.querySelectorAll("form").forEach(function(f){' +
  'var done=false,b=f.querySelector("[data-submit]"),s=f.querySelector("[data-status]"),label=b&&b.textContent;' +
  'f.addEventListener("submit",function(e){if(done){e.preventDefault();return;}done=true;' +
  'if(b){b.disabled=true;b.classList.add("busy");b.textContent=f.getAttribute("data-busy")||"Working\\u2026";}' +
  "if(s){s.hidden=false;}});" +
  'window.addEventListener("pageshow",function(e){if(e.persisted){done=false;' +
  "if(b){b.disabled=false;b.classList.remove(\"busy\");b.textContent=label;}if(s){s.hidden=true;}}});});";

/** CSP source for SUBMIT_SCRIPT, so scripts never need `unsafe-inline`. */
export const SUBMIT_SCRIPT_HASH = `'sha256-${createHash("sha256").update(SUBMIT_SCRIPT).digest("base64")}'`;

/** A CSP `form-action` source for the client's redirect: its origin, or its scheme for app links. */
export function formActionSource(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
}

/**
 * Redirect targets the sign-in page trusts without asking: the known MCP clients. Anyone can
 * register a client under any name, so for any other target the user must confirm where the
 * authorization code goes.
 */
export const TRUSTED_REDIRECTS = {
  /** Exact host match, https only. */
  hosts: ["claude.ai", "claude.com"],
  /** Loopback, http or https, any port: a desktop client listening on the user's own machine. */
  loopbackHosts: ["127.0.0.1", "localhost", "[::1]"],
  /** App links. */
  schemes: ["cursor:", "vscode:", "vscode-insiders:"],
} as const;

export function isTrustedRedirect(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol === "https:" && (TRUSTED_REDIRECTS.hosts as readonly string[]).includes(url.hostname)) return true;
  if ((url.protocol === "http:" || url.protocol === "https:") && (TRUSTED_REDIRECTS.loopbackHosts as readonly string[]).includes(url.hostname)) return true;
  return (TRUSTED_REDIRECTS.schemes as readonly string[]).includes(url.protocol);
}

/** What the user is told the code goes to: the host for a web URL, the scheme for an app link. */
export function redirectTarget(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === "http:" || url.protocol === "https:" ? url.host : url.protocol;
}

/** Browsers apply `form-action` to the redirect after a submit, so the client's origin must be in it. */
export function pageHeaders(redirectUri?: string): Record<string, string> {
  const formAction = ["'self'", ...(redirectUri ? [formActionSource(redirectUri)] : [])].join(" ");
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; script-src ${SUBMIT_SCRIPT_HASH}; style-src 'unsafe-inline'; form-action ${formAction}`,
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

const STYLE = `<style>
:root{color-scheme:light dark;--bg:#f6f8fa;--card:#fff;--line:#d0d7de;--text:#1f2328;--muted:#59636e;--input:#fff;--err-bg:#ffebe9;--err:#82071e;--accent:#d4202c;--btn-text:#fff}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--muted:#9198a1;--input:#0d1117;--err-bg:#3d1214;--err:#ffb3ad;--accent:#ff6b6b;--btn-text:#0d1117}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;width:100%;max-width:400px}
.brand{font-weight:700;font-size:1.05rem;letter-spacing:.02em;margin:0 0 18px;color:var(--accent)}
h1{font-size:1.25rem;margin:0 0 6px}p{color:var(--muted);margin:0 0 16px;line-height:1.45}
label{display:block;font-size:.9rem;margin:14px 0 4px}
input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--input);color:var(--text);font-size:16px}
input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:var(--btn-text);font-size:1rem;font-weight:600;cursor:pointer}
button:disabled{cursor:wait;opacity:.85}
button.busy::before{content:"";display:inline-block;width:1em;height:1em;margin-right:.6em;vertical-align:-.15em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:tg-spin .8s linear infinite}
@keyframes tg-spin{to{transform:rotate(360deg)}}
[data-status]{margin:12px 0 0;font-size:.9rem}
.error{background:var(--err-bg);color:var(--err);border-radius:8px;padding:10px;margin-bottom:8px}
footer{margin-top:16px;font-size:.8rem;color:var(--muted);text-align:center;max-width:400px}footer a{color:inherit}
</style>`;

export function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>${STYLE}</head><body><main>
<div class="brand">Technogym · mywellness</div>
${body}</main><footer>Open source · <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">technogym-js on GitHub</a> · Not affiliated with Technogym</footer></body></html>`;
}

export function credentialsPage(o: { action: string; request: string; clientName: string | null; redirectUri: string; email?: string; error?: string }): string {
  const target = escape(redirectTarget(o.redirectUri));
  const client = o.clientName ? `an app that calls itself <strong>${escape(o.clientName)}</strong>` : "your MCP client";
  const trust = isTrustedRedirect(o.redirectUri)
    ? ""
    : `<div class="error">${target} is not a known MCP client. Only continue if you started this from an app you trust.</div>
<label style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" name="confirmRedirect" value="1" required>I trust ${target} with access to my mywellness data</label>`;
  return shell(
    "Sign in to mywellness",
    `<h1>Sign in to mywellness</h1>
<p>Sign in with your Technogym mywellness account to use your gym training data in ${client}. Your password goes only to mywellness and is never stored.</p>
<p>After you sign in, you'll be sent to <strong>${target}</strong>.</p>
${o.error ? `<div class="error" role="alert">${escape(o.error)}</div>` : ""}
<form method="post" action="${escape(o.action)}" data-busy="Signing in…"><input type="hidden" name="request" value="${escape(o.request)}">
<label for="email">Email</label><input id="email" name="email" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escape(o.email ?? "")}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<label style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" name="disconnectOthers" value="1">Disconnect my other Technogym connections</label>
${trust}
<button type="submit" data-submit>Sign in</button>
<p data-status role="status" hidden>Signing in to mywellness. Keep this window open.</p></form><script>${SUBMIT_SCRIPT}</script>`,
  );
}

/** A page with no form, e.g. an expired sign-in. Plain text in, escaped here. */
export const errorPage = (message: string): string => shell("mywellness sign-in", `<h1>mywellness sign-in</h1><p>${escape(message)}</p>`);
