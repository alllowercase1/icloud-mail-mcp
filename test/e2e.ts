// End-to-end check against `wrangler dev` (see README "Testing"): the full OAuth flow Claude
// performs, then MCP calls that reach the test IMAP server through Workers' connect().
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.BASE || "http://localhost:8787";
const OWNER = process.env.OWNER_PASSWORD || "correct-horse-battery-staple-42";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const b64url = (b: Buffer) => b.toString("base64url");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log("ok  ", name);
}

function cookiesFrom(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function main() {
  let resourceMeta: any;
  await test("unauthenticated MCP call gets 401 pointing at resource metadata", async () => {
    const res = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 401);
    const wa = res.headers.get("www-authenticate") || "";
    assert.match(wa, /resource_metadata="([^"]+)"/);
    const metaUrl = /resource_metadata="([^"]+)"/.exec(wa)![1];
    resourceMeta = await (await fetch(metaUrl)).json();
    assert.equal(resourceMeta.resource, `${BASE}/mcp`);
  });

  let asMeta: any;
  await test("authorization server metadata advertises DCR and PKCE", async () => {
    asMeta = await (await fetch(`${resourceMeta.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
    assert.ok(asMeta.registration_endpoint);
    assert.ok(asMeta.code_challenge_methods_supported.includes("S256"));
  });

  await test("registration with a non-Claude redirect is refused", async () => {
    const res = await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
    });
    assert.equal(res.status, 400);
  });

  let client: any;
  await test("registration with Claude's callback succeeds", async () => {
    const res = await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    client = await res.json();
  });

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(8));
  const authUrl = new URL(asMeta.authorization_endpoint);
  Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "mail:read",
    resource: resourceMeta.resource,
  }).forEach(([k, v]) => authUrl.searchParams.set(k, v));

  let handle = "";
  let cookies = "";
  await test("consent page renders with a password field", async () => {
    const res = await fetch(authUrl);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /type="password"/);
    assert.match(html, /claude\.ai/);
    handle = /name="handle" value="([^"]+)"/.exec(html)![1];
    cookies = cookiesFrom(res);
  });

  const post = (fields: Record<string, string>) =>
    fetch(`${BASE}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE }, // no cookie: iPhone sign-in sheets may drop it
      body: new URLSearchParams(fields),
    });

  await test("tampered sign-in handle is refused", async () => {
    const bad = handle.slice(0, -2) + (handle.endsWith("AA") ? "BB" : "AA");
    const res = await post({ handle: bad, decision: "approve", password: OWNER });
    assert.equal(res.status, 400);
  });

  await test("wrong owner password is refused", async () => {
    const res = await post({ handle, decision: "approve", password: "nope" });
    assert.equal(res.status, 401);
  });

  let code = "";
  await test("right owner password redirects to Claude with a code", async () => {
    const res = await post({ handle, decision: "approve", password: OWNER });
    assert.equal(res.status, 302, await res.clone().text());
    const loc = new URL(res.headers.get("location")!);
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get("state"), state);
    code = loc.searchParams.get("code")!;
    assert.ok(code);
  });

  let token: any;
  await test("code exchange with PKCE gives access and refresh tokens", async () => {
    const res = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: resourceMeta.resource }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    token = await res.json();
    assert.ok(token.access_token && token.refresh_token);
  });

  const mcp = (body: unknown, auth = token.access_token) =>
    fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });

  await test("bogus token is refused", async () => {
    const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "owner:xxx:yyy");
    assert.equal(res.status, 401);
  });

  await test("MCP initialize + tools/list with the token", async () => {
    const init = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } })).json()) as any;
    assert.equal(init.result.serverInfo.name, "icloud-mail");
    const list = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
    assert.equal(list.result.tools.length, 3);
  });

  await test("tools/call reaches IMAP through Workers sockets", async () => {
    const res = (await (await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_messages", arguments: {} } })).json()) as any;
    assert.ok(!res.result.isError, res.result.content[0].text);
    const data = JSON.parse(res.result.content[0].text);
    assert.equal(data.messages[0].subject, "Tour budget");
    const msg = (await (await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_message", arguments: { uid: data.messages[0].uid } } })).json()) as any;
    assert.match(JSON.parse(msg.result.content[0].text).body, /Budget attached tomorrow/);
  });

  await test("refresh token works", async () => {
    const res = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: client.client_id, resource: resourceMeta.resource }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  });

  await test("repeated wrong passwords lock sign-in for the hour", async () => {
    const page = await fetch(authUrl);
    const html = await page.text();
    handle = /name="handle" value="([^"]+)"/.exec(html)![1];
    cookies = cookiesFrom(page);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await post({ handle, decision: "approve", password: "wrong" + i })).status;
    assert.equal(last, 429);
    const blocked = await post({ handle, decision: "approve", password: OWNER });
    assert.equal(blocked.status, 429, "even the right password waits once locked");
  });

  console.log(`\n${passed} end-to-end checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
