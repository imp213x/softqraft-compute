/**
 * Browser-facing rules, copied from Realtime Media:
 * - cookie-authenticated mutations must come from this service's own origin
 *   (the `Origin` header must equal COMPUTE_PUBLIC_URL's origin, or the
 *   request's own origin when that is not set, for local runs);
 * - every `/console` and `/admin` response carries the same security headers.
 */

import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors.js";

function canonicalOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Throws 403 `cross_origin` unless the request's Origin is this service's origin. */
export function requireSameOriginMutation(req: FastifyRequest, publicUrl: string | null): void {
  const supplied = typeof req.headers.origin === "string" ? canonicalOrigin(req.headers.origin) : null;
  const configured = publicUrl ? canonicalOrigin(publicUrl) : null;
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const requestOrigin = host ? canonicalOrigin(`${req.protocol || "http"}://${host}`) : null;
  const expected = configured ?? requestOrigin;
  if (!supplied || !expected || supplied !== expected) {
    throw new HttpError(403, "cross_origin", "Cross-origin request rejected");
  }
}

export function applyBrowserSecurityHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  );
}
