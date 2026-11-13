// iCloud Mail connector for Claude: a read-only remote MCP server on Cloudflare Workers,
// protected by OAuth. Only someone who knows OWNER_PASSWORD can approve a connection,
// and only Claude's own OAuth callback can receive the resulting tokens.
import { connect } from "cloudflare:sockets";
import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { handleMcp } from "./mcp";
import type { MailConfig } from "./mail";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ICLOUD_USER: string;
  ICLOUD_APP_PASSWORD: string;
  OWNER_PASSWORD: string;
  IMAP_HOST?: string;
  IMAP_PORT?: string;
  IMAP_TLS?: string; // "on" (default) or "off" for local testing only
  ALLOWED_REDIRECT_URIS?: string; // comma-separated; defaults to Claude's callbacks
}

const SCOPE = "mail:read";
const DEFAULT_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
const MAX_FAILED_LOGINS_PER_HOUR = 10;
const PENDING_TTL_SECONDS = 1800;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function handleKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(env.OWNER_PASSWORD), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("icloud-mail-mcp"), info: enc.encode("consent-handle-v1") },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

// The pending authorization request travels in the form itself, signed and time-limited, so
// signing in needs neither a cookie (Claude's in-app sign-in sheet on iPhone drops it) nor a
// storage read that could miss right after the write. Approval still needs OWNER_PASSWORD,
// and the redirect is re-checked against Claude's registered callback when completing.
async function sealRequest(env: Env, authReq: AuthRequest): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ r: authReq, e: Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await handleKey(env), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

async function openRequest(env: Env, handle: string): Promise<AuthRequest | null> {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(handle);
  if (!m || handle.length > 8000) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await handleKey(env), fromB64url(m[2]), enc.encode(m[1]));
    if (!ok) return null;
    const { r, e } = JSON.parse(new TextDecoder().decode(fromB64url(m[1])));
    if (typeof e !== "number" || e < Date.now() / 1000) return null;
    return r as AuthRequest;
  } catch {
    return null;
  }
}

function allowedRedirects(env: Env): string[] {
  const custom = (env.ALLOWED_REDIRECT_URIS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_REDIRECTS;
}

function mailConfig(env: Env): MailConfig {
  return {
    user: (env.ICLOUD_USER || "").trim(),
    password: (env.ICLOUD_APP_PASSWORD || "").trim(),
    openTransport: async () => {
      const socket = connect(
        { hostname: env.IMAP_HOST || "imap.mail.me.com", port: parseInt(env.IMAP_PORT || "993", 10) },
        { secureTransport: env.IMAP_TLS === "off" ? "off" : "on", allowHalfOpen: false },
      );
      await socket.opened;
      return socket;
    },
  };
}

// ---------- MCP endpoint (only reached with a valid access token) ----------

const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleMcp(request, mailConfig(env));
  },
};

// ---------- everything else: home page and the owner sign-in / consent page ----------

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("X-Frame-Options", "DENY");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Cache-Control", "no-store");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#111}input{background:#222;color:#f5f5f7;border-color:#444}}
h1{font-size:22px;margin:0 0 12px}p{margin:8px 0}.muted{color:#86868b;font-size:14px}.err{color:#d70015}
input[type=password]{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border:1px solid #ccc;border-radius:8px;margin:8px 0 12px}
button{font-size:16px;padding:10px 16px;border-radius:8px;border:0;cursor:pointer;margin-right:8px}
.allow{background:#0071e3;color:#fff}.deny{background:#e5e5ea;color:#1d1d1f}
</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: h });
}

function consentForm(details: ConsentDescription | null, handle: string, error?: string): string {
  const who = details ? escape(details.clientName) : "Claude";
  const where = details ? `<p class="muted">Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>` : "";
  return `<h1>Connect ${who} to your iCloud Mail?</h1>
<p>${who} will be able to <strong>read</strong> your iCloud mail. It cannot send, delete or move anything.</p>
${where}
${error ? `<p class="err">${escape(error)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<label for="pw">Connector password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
<button class="allow" name="decision" value="approve">Allow</button>
<button class="deny" name="decision" value="deny" formnovalidate>Deny</button>
</form>`;
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function throttleKey(): string {
  return "icloudmcp:failed-logins:" + new Date().toISOString().slice(0, 13); // per UTC hour
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!env.OWNER_PASSWORD || env.OWNER_PASSWORD.length < 16) {
    return page("Not set up", "<h1>Not set up yet</h1><p>Set the OWNER_PASSWORD secret (at least 16 characters) and deploy again.</p>", 503);
  }
  try {
    if (request.method === "GET") {
      const authReq = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authReq);
      const handle = await sealRequest(env, authReq);
      return page("Connect iCloud Mail", consentForm(details, handle), 200);
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") || "");
      const authReq = await openRequest(env, handle);
      if (!authReq) {
        return page("Can't connect", "<h1>Can't connect</h1><p>This sign-in page expired.</p><p class=\"muted\">Start again from Claude.</p>", 400);
      }
      if (form.get("decision") !== "approve") {
        const back = new URL(authReq.redirectUri);
        back.searchParams.set("error", "access_denied");
        if (authReq.state) back.searchParams.set("state", authReq.state);
        return Response.redirect(back.toString(), 302);
      }
      const failures = parseInt((await env.OAUTH_KV.get(throttleKey())) || "0", 10);
      if (failures >= MAX_FAILED_LOGINS_PER_HOUR) {
        return page("Try later", "<h1>Too many wrong passwords</h1><p>Sign-in is paused for up to an hour. Try again later.</p>", 429);
      }
      if (!(await passwordMatches(String(form.get("password") || ""), env.OWNER_PASSWORD))) {
        await env.OAUTH_KV.put(throttleKey(), String(failures + 1), { expirationTtl: 7200 });
        return page("Connect iCloud Mail", consentForm(null, handle, "Wrong password. Try again."), 401);
      }
      const { redirectTo } = await oauth.completeAuthorization({
        request: authReq,
        userId: "owner",
        metadata: {},
        scope: [SCOPE],
        props: { owner: true },
      });
      return new Response(null, { status: 302, headers: { Location: redirectTo, "Cache-Control": "no-store" } });
    }
    return new Response("Method Not Allowed", { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return page("Can't connect", `<h1>Can't connect</h1><p>${escape(message || "This request is not valid.")}</p><p class="muted">Start again from Claude.</p>`, 400);
    }
    throw error;
  }
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return authorize(request, env);
    if (url.pathname === "/" && request.method === "GET") {
      return page(
        "iCloud Mail connector",
        `<h1>iCloud Mail connector</h1><p>This server is running. In Claude, add a custom connector with this URL:</p><p><strong>${escape(url.origin)}/mcp</strong></p>`,
      );
    }
    return new Response("Not found", { status: 404 });
  },
};

// The provider needs this Worker's public URL; it is taken from the first request so the
// code works on any workers.dev subdomain without editing.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string, env: Env): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (p) return p;
  p = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler as any,
    defaultHandler: defaultHandler as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    accessTokenTTL: 3600,
    refreshTokenTTL: 90 * 86400,
    refreshTokenIdleTTL: 90 * 86400, // stays connected as long as Claude uses it at least every 90 days
    clientRegistrationCallback: ({ clientMetadata }) => {
      // Only Claude's own OAuth callback may register, so tokens can never be sent anywhere else.
      const uris = clientMetadata.redirect_uris;
      const allowed = allowedRedirects(env);
      if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && allowed.includes(u))) {
        return { code: "invalid_redirect_uri", description: "This connector only accepts Claude's own redirect address.", status: 400 };
      }
      return undefined;
    },
  });
  providers.set(origin, p);
  return p;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin, env).fetch(request, env, ctx);
  },
};
