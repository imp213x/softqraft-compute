/**
 * Web: the Console (`/console/`) and staff Admin (`/admin/`) pages, served
 * as static, framework-free ES modules from `apps/console`, exactly as
 * Realtime Media serves its Console. There is no build step.
 *
 * - Pages and files carry the browser security headers of their context
 *   (no-store caching and the strict CSP in `lib/browser.ts`).
 * - Only files under `modules/`, `styles/` and `assets/` are served, with a
 *   fixed content type per extension; anything else is a 404.
 * - `GET /console/v1/auth/status` and `GET /admin/v1/auth/status` (no
 *   session) tell the page where "Sign in again" goes: Cloud's
 *   `/cloud/open/compute`, or Ops → Service operations, on CLOUD_ORIGIN.
 */

import { fileURLToPath } from "node:url";

export { registerAdminWebRoutes, registerConsoleWebRoutes, type WebDeps } from "./routes.js";

/** `apps/console`, from both `src/modules/web` and `dist/modules/web`. */
export const CONSOLE_APP_DIR = fileURLToPath(new URL("../../../../console/", import.meta.url));

/** Cloud's direct-open path for Compute's Console (Cloud `/cloud/open/:serviceId`). */
export const CLOUD_OPEN_COMPUTE_PATH = "/cloud/open/compute";
/** Ops → Service operations, where staff open Compute's Admin. */
export const OPS_SERVICE_OPERATIONS_PATH = "/dashboard/services";

export function signInUrl(cloudOrigin: string | null, path: string): string | null {
  return cloudOrigin ? `${cloudOrigin}${path}` : null;
}
