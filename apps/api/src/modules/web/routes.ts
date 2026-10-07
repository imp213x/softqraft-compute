/**
 * Static page routes for `/console/` and `/admin/`, and the public status
 * routes that name the "Sign in again" destination. Registered inside the
 * Console and Admin contexts, so their security headers apply.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError, sendError } from "../../lib/errors.js";
import { CLOUD_OPEN_COMPUTE_PATH, CONSOLE_APP_DIR, OPS_SERVICE_OPERATIONS_PATH, signInUrl } from "./index.js";

export interface WebDeps {
  cloudOrigin: string | null;
  hostRunbookUrl: string;
  /** Defaults to `apps/console`. */
  appDir?: string;
}

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
});

const SUBDIRS = ["modules", "styles", "assets"] as const;

const notFound = (req: FastifyRequest, reply: FastifyReply) => sendError(req, reply, new HttpError(404, "not_found", "Not found"));

/** A file under `<appDir>/<subdir>/`, or null for anything outside it or of an unknown type. */
export function resolveAsset(appDir: string, subdir: string, rel: string): string | null {
  if (!rel || rel.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(rel)) return null;
  if (rel.split("/").some((seg) => seg === "" || seg.startsWith("."))) return null;
  const base = path.resolve(appDir, subdir);
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) return null;
  if (!TYPES[path.extname(file).toLowerCase()]) return null;
  return file;
}

function registerPages(app: FastifyInstance, base: "/console" | "/admin", page: string, appDir: string): void {
  const sendPage = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const html = await readFile(path.join(appDir, page), "utf8");
      return reply.type("text/html; charset=utf-8").send(html);
    } catch {
      return notFound(req, reply);
    }
  };
  app.get(base, async (_req, reply) => reply.redirect(`${base}/`));
  app.get(`${base}/`, sendPage);
  // The launch grant travels only in the URL fragment (§4); the page redeems it.
  app.get(`${base}/launch`, sendPage);
  for (const subdir of SUBDIRS) {
    app.get(`${base}/${subdir}/*`, async (req, reply) => {
      const rel = (req.params as { "*"?: string })["*"] ?? "";
      const file = resolveAsset(appDir, subdir, rel);
      if (!file) return notFound(req, reply);
      try {
        const body = await readFile(file);
        return reply.type(TYPES[path.extname(file).toLowerCase()]!).send(body);
      } catch {
        return notFound(req, reply);
      }
    });
  }
}

export function registerConsoleWebRoutes(app: FastifyInstance, deps: WebDeps): void {
  registerPages(app, "/console", "console.html", deps.appDir ?? CONSOLE_APP_DIR);
  app.get("/console/v1/auth/status", async () => ({
    signInUrl: signInUrl(deps.cloudOrigin, CLOUD_OPEN_COMPUTE_PATH),
  }));
}

export function registerAdminWebRoutes(app: FastifyInstance, deps: WebDeps): void {
  registerPages(app, "/admin", "admin.html", deps.appDir ?? CONSOLE_APP_DIR);
  app.get("/admin/v1/auth/status", async () => ({
    signInUrl: signInUrl(deps.cloudOrigin, OPS_SERVICE_OPERATIONS_PATH),
    hostRunbookUrl: deps.hostRunbookUrl,
  }));
}
