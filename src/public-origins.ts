/** Explicit public origins, independent of proxy headers and OAuth resource aliases. */
export function parsePublicOrigin(value: string, name = "publicBaseUrl"): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`Invalid ${name}: expected an absolute HTTPS origin`); }
  if (url.protocol === "http:" && url.hostname === "[::1]") {
    throw new Error(`Invalid ${name}: the installed OAuth SDK requires HTTPS for IPv6 issuers; HTTP is supported only on localhost or 127.0.0.1`);
  }
  const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (!/^https?:\/\/[^/?#]+\/?$/.test(value) || /[\s\\*@]/.test(value)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error(`Invalid ${name}: use an HTTPS origin without a path, query, fragment or credentials (HTTP on localhost or 127.0.0.1 is allowed)`);
  }
  return url.origin;
}

export function publicOrigins(primary: string, aliases: readonly string[] = []): string[] {
  const origins = Array.from(new Set([
    parsePublicOrigin(primary),
    ...aliases.map((value) => parsePublicOrigin(value, "publicBaseUrlAliases")),
  ]));
  const hosts = new Map<string, string>();
  for (const origin of origins) {
    const host = new URL(origin).host;
    if (hosts.has(host) && hosts.get(host) !== origin) {
      throw new Error("Public origins with the same Host must use the same protocol");
    }
    hosts.set(host, origin);
  }
  return origins;
}
