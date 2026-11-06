import assert from "node:assert/strict";
import { parsePublicOrigin } from "./public-origins.js";
import { readFileSync } from "node:fs";
import {
  devspaceConfigJsonSchema,
  devspaceConfigSchema,
} from "./config-schema.js";

assert.throws(
  () => devspaceConfigSchema.parse({ configVersion: 1, typo: true }),
  /Unrecognized key/,
);

for (const url of [
  "https://tunnel.example.com/v1/mcp/tunnel_123",
  "http://localhost:7676/mcp",
  "http://127.0.0.1:7676/mcp",
  "http://[::1]:7676/mcp",
]) {
  assert.doesNotThrow(() => devspaceConfigSchema.parse({
    configVersion: 1, oauth: { allowedResourceUrls: [url] },
  }), url);
}
for (const url of [
  "http://tunnel.example.com/mcp", "http://192.168.1.1/mcp",
  "http://localhost.example.com/mcp", "http://127.0.0.1.example.com/mcp",
  "http://[::2]/mcp", "ftp://localhost/mcp", "file:///mcp",
  "custom://tunnel.example.com/mcp", "not-a-url",
]) {
  assert.equal(devspaceConfigSchema.safeParse({
    configVersion: 1, oauth: { allowedResourceUrls: [url] },
  }).success, false, url);
}

for (const origin of ["https://old.example.com", "http://localhost:7676", "http://127.0.0.1:7676", "https://[::1]:7676"]) {
  assert.equal(devspaceConfigSchema.safeParse({ configVersion: 1, server: { publicBaseUrlAliases: [origin] } }).success, true, origin);
}
for (const origin of ["https://old.example.com/path", "https://old.example.com/..", "https://old.example.com?", "https://old.example.com#",
  "https://user:password@old.example.com", "https://@old.example.com", "https://*.example.com", "http://remote.example.com", "http://[::1]:7676", "ftp://localhost"]) {
  assert.equal(devspaceConfigSchema.safeParse({ configVersion: 1, server: { publicBaseUrlAliases: [origin] } }).success, false, origin);
  assert.equal(devspaceConfigSchema.safeParse({ configVersion: 1, server: { publicBaseUrl: origin } }).success, false, origin);
}

assert.throws(() => parsePublicOrigin("http://[::1]:7676"), /OAuth SDK requires HTTPS for IPv6 issuers/);

const generatedSchema = `${JSON.stringify(devspaceConfigJsonSchema(), null, 2)}\n`;
const committedSchema = readFileSync(
  new URL("../schema/v1/devspace.schema.json", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
assert.equal(committedSchema, generatedSchema, "run `npm run schema:config` after changing config-schema.ts");

console.log("config schema tests passed");
