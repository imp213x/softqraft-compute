/**
 * How a service declares its federation abilities to Cloud (brief D1, D2,
 * §3a). Cloud's registry holds one descriptor per service; the service uses
 * the same values for its audience and return-path policy.
 */

import type { ReturnPathOptions } from "./paths.js";
import { validateServiceId } from "./roles.js";

export interface ServiceFederationDescriptor {
  /** Registry id, e.g. `realtime-media`. */
  id: string;
  /** Canonical-string audience. Equals `id` (contract §8.1). */
  audience: string;
  /** Customer Console launch (§3.2). */
  consoleLaunch: boolean;
  /** Staff operator launch (§8.2). */
  operatorLaunch: boolean;
  /** Accepts §3.3 principal revocations. */
  revocation: boolean;
  /** Operator Admin base path, e.g. `/admin`. Required when `operatorLaunch`. */
  adminBasePath?: string;
  /** Operator Admin API prefix, e.g. `/admin/v1/`. Required when `operatorLaunch`. */
  adminApiPrefix?: string;
}

export type DescriptorValidation = { ok: true } | { ok: false; errors: string[] };

const BASE_PATH_RE = /^(\/[a-z0-9-]+)+$/;
const API_PREFIX_RE = /^(\/[a-z0-9-]+)+\/$/;

export function validateDescriptor(value: unknown): DescriptorValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["descriptor must be an object"] };
  }
  const d = value as Record<string, unknown>;
  if (!validateServiceId(d.id)) {
    errors.push("id must be 2-40 characters of a-z 0-9 -");
  }
  if (d.audience !== d.id) {
    errors.push("audience must equal id");
  }
  for (const flag of ["consoleLaunch", "operatorLaunch", "revocation"] as const) {
    if (typeof d[flag] !== "boolean") errors.push(`${flag} must be a boolean`);
  }
  const base = d.adminBasePath;
  const api = d.adminApiPrefix;
  if (base !== undefined && (typeof base !== "string" || !BASE_PATH_RE.test(base))) {
    errors.push("adminBasePath must look like /admin (lowercase segments, no trailing /)");
  }
  if (api !== undefined && (typeof api !== "string" || !API_PREFIX_RE.test(api))) {
    errors.push("adminApiPrefix must look like /admin/v1/ (lowercase segments, trailing /)");
  }
  if (typeof base === "string" && typeof api === "string" && !api.startsWith(`${base}/`)) {
    errors.push("adminApiPrefix must be under adminBasePath");
  }
  if (d.operatorLaunch === true) {
    if (base === undefined) errors.push("adminBasePath is required when operatorLaunch is true");
    if (api === undefined) errors.push("adminApiPrefix is required when operatorLaunch is true");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * The §8.2 return-path policy for a descriptor: under `adminBasePath`,
 * never under `adminApiPrefix`. Throws if operator launch is not configured.
 */
export function operatorReturnPathPolicy(
  descriptor: ServiceFederationDescriptor,
): Required<ReturnPathOptions> {
  if (!descriptor.adminBasePath || !descriptor.adminApiPrefix) {
    throw new Error("Descriptor has no operator Admin paths");
  }
  return {
    basePath: descriptor.adminBasePath,
    forbiddenPrefixes: [descriptor.adminApiPrefix],
  };
}
