import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.js";

const legacy = "https://devserver.ciward.dpdns.org";
const canonical = "https://devserver.ciward.com";
const ownerToken = "test-owner-token-that-is-long-enough";
const redirect = "http://127.0.0.1/callback";
const verifier = "domain-migration-verifier-012345678901234567890123456789";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const tokenHash = (token: string) => createHash("sha256").update(token).digest("base64url");
type Tokens = { access_token: string; refresh_token: string };

// Native fetch can replace a supplied Host; exercise the real virtual-host boundary.
function hostRequest(base: string, host: string, path: string, init: {
  method?: string; headers?: Record<string, string>; body?: string;
} = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request(new URL(path, base), {
      method: init.method ?? "GET", headers: { Host: host, ...init.headers },
      signal: AbortSignal.timeout(10_000),
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        const status = incoming.statusCode ?? 500;
        resolve(new Response([204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers }));
      });
    });
    outgoing.on("error", reject);
    outgoing.end(init.body);
  });
}

test("domain migration preserves old tokens and shares codes while discovery follows trusted Host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-domain-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  async function start(primary: string, aliases: string[]) {
    const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
      server: { publicBaseUrl: primary, publicBaseUrlAliases: aliases },
      storage: { stateDir },
      workspaces: { allowedRoots: [root], worktreeRoot: join(root, "trees") },
      ui: { enabled: false }, logging: { level: "silent" },
    }));
    const running = createServer(config, { incomingArtifactAdapters: [] });
    const listener = running.app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      await running.close();
    };
    t.after(close);
    const call = (origin: string, path: string, init: Parameters<typeof hostRequest>[3] = {}) =>
      hostRequest(base, new URL(origin).host, path, init);
    const form = (origin: string, path: string, body: Record<string, string>) => call(origin, path, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString(),
    });
    const mcp = (origin: string, accessToken?: string) => call(origin, "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "migration-test", version: "1.0.0" },
      } }),
    });
    const approve = async (origin: string, clientId: string, resource: string) => {
      const response = await form(origin, "/authorize", {
        client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge,
        code_challenge_method: "S256", scope: "devspace", resource, state: "migration-state", owner_token: ownerToken,
      });
      assert.equal(response.status, 302, await response.clone().text());
      return new URL(response.headers.get("location")!).searchParams.get("code")!;
    };
    const exchange = (origin: string, clientId: string, code: string, resource: string) => form(origin, "/token", {
      grant_type: "authorization_code", client_id: clientId, redirect_uri: redirect, code, code_verifier: verifier, resource,
    });
    return { config, base, close, call, form, mcp, approve, exchange };
  }

  const first = await start(legacy, []);
  const registration = await first.call(legacy, "/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "migration-test", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none" }) });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json() as { client_id: string };
  const code = await first.approve(legacy, client.client_id, `${legacy}/mcp`);
  const tokenResponse = await first.exchange(legacy, client.client_id, code, `${legacy}/mcp`);
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  const tokens = await tokenResponse.json() as Tokens;
  await first.close();

  const before = new SqliteOAuthStore(stateDir);
  const savedClient = before.getClient(client.client_id);
  const savedAccess = before.getAccessToken(tokenHash(tokens.access_token));
  const savedRefresh = before.getRefreshToken(tokenHash(tokens.refresh_token));
  before.close();
  const second = await start(canonical, [legacy]);
  const after = new SqliteOAuthStore(stateDir);
  assert.deepEqual(after.getClient(client.client_id), savedClient);
  assert.deepEqual(after.getAccessToken(tokenHash(tokens.access_token)), savedAccess);
  assert.deepEqual(after.getRefreshToken(tokenHash(tokens.refresh_token)), savedRefresh);
  after.close();

  for (const origin of [legacy, canonical]) {
    const metadataResponse = await second.call(origin, "/.well-known/oauth-authorization-server");
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.issuer, `${origin}/`);
    assert.equal(metadata.token_endpoint, `${origin}/token`);
    const resource = await (await second.call(origin, "/.well-known/oauth-protected-resource/mcp")).json();
    assert.equal(resource.resource, `${origin}/mcp`);
    assert.deepEqual(resource.authorization_servers, [`${origin}/`]);
    const denied = await second.mcp(origin);
    assert.equal(denied.status, 401);
    assert.ok(denied.headers.get("www-authenticate")!.includes(`${origin}/.well-known/oauth-protected-resource/mcp`));
    const accepted = await second.mcp(origin, tokens.access_token);
    assert.equal(accepted.status, 200, await accepted.clone().text());
  }
  const unknown = await hostRequest(second.base, "evil.example", "/.well-known/oauth-authorization-server");
  assert.equal(unknown.status, 403);
  const spoofed = await second.call(legacy, "/.well-known/oauth-authorization-server", {
    headers: { "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http" },
  });
  assert.equal((await spoofed.json()).issuer, `${legacy}/`);

  const wrongResource = await second.form(canonical, "/token", { grant_type: "refresh_token", client_id: client.client_id,
    refresh_token: tokens.refresh_token, resource: `${canonical}/mcp` });
  assert.equal(wrongResource.status, 400);
  const refreshed = await second.form(canonical, "/token", { grant_type: "refresh_token", client_id: client.client_id,
    refresh_token: tokens.refresh_token, resource: `${legacy}/mcp` });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const renewed = await refreshed.json() as Tokens;
  const store = new SqliteOAuthStore(stateDir);
  assert.equal(store.getAccessToken(tokenHash(renewed.access_token))!.resource, `${legacy}/mcp`);
  assert.equal(store.getRefreshToken(tokenHash(renewed.refresh_token))!.resource, `${legacy}/mcp`);
  store.close();
  assert.equal((await second.mcp(canonical, renewed.access_token)).status, 200);

  // Both hostnames exchange codes through the same provider and in-memory Map.
  const pendingCode = await second.approve(legacy, client.client_id, `${legacy}/mcp`);
  assert.equal((await second.exchange(canonical, client.client_id, pendingCode, `${canonical}/mcp`)).status, 400);
  assert.equal((await second.exchange(canonical, client.client_id, pendingCode, `${legacy}/mcp`)).status, 200);
  assert.equal((await second.exchange(legacy, client.client_id, pendingCode, `${legacy}/mcp`)).status, 400);
  const newCode = await second.approve(canonical, client.client_id, `${canonical}/mcp`);
  assert.equal((await second.exchange(canonical, client.client_id, newCode, `${canonical}/mcp`)).status, 200);
});
