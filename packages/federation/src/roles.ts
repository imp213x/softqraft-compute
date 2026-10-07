/**
 * Staff permission naming and operator role resolution (brief D3).
 *
 * `service:<id>:operate` asserts `admin`, or `owner` when the person also
 * holds Super Admin. `service:<id>:view` asserts `viewer`. Super Admin alone
 * opens no service's Admin.
 */

import type { OperatorRole } from "./contract.js";

const SERVICE_ID_RE = /^[a-z0-9-]{2,40}$/;

/** A service id (and audience): lowercase `a-z`, `0-9` and `-`, 2 to 40 characters. */
export function validateServiceId(serviceId: unknown): serviceId is string {
  return typeof serviceId === "string" && SERVICE_ID_RE.test(serviceId);
}

export type ServiceAction = "operate" | "view";

/** Permission slug for a service action. Throws on an invalid id or action. */
export function servicePermission(serviceId: string, action: ServiceAction): string {
  if (!validateServiceId(serviceId)) {
    throw new Error("Service id must be 2-40 characters of a-z 0-9 -");
  }
  if (action !== "operate" && action !== "view") {
    throw new Error('Service action must be "operate" or "view"');
  }
  return `service:${serviceId}:${action}`;
}

/** Both permission slugs for a service. */
export function servicePermissions(serviceId: string): { operate: string; view: string } {
  return {
    operate: servicePermission(serviceId, "operate"),
    view: servicePermission(serviceId, "view"),
  };
}

/**
 * Resolve the operator role Cloud asserts in an operator launch.
 * Returns null when the person may not open the service's Admin at all.
 */
export function resolveOperatorRole(input: {
  canOperate: boolean;
  canView: boolean;
  isSuperAdmin: boolean;
}): OperatorRole | null {
  if (input.canOperate === true) {
    return input.isSuperAdmin === true ? "owner" : "admin";
  }
  if (input.canView === true) return "viewer";
  return null;
}

/** True when a platform operator role may perform writes. `viewer` never may. */
export function operatorRoleCanWrite(role: OperatorRole): boolean {
  return role === "owner" || role === "admin";
}
