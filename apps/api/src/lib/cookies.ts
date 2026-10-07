/**
 * Minimal cookie helpers (no @fastify/cookie dependency), as in Realtime
 * Media. Cookie values are session tokens: never log them.
 */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // A malformed value is ignored, as if the cookie were absent.
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSec?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  clear?: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${opts.clear ? "" : encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`];
  if (opts.clear) parts.push("Max-Age=0");
  else if (opts.maxAgeSec != null) parts.push(`Max-Age=${opts.maxAgeSec}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}
