/**
 * Every error the API can return becomes one plain sentence with the next
 * step. Codes are keys only and are never shown, nor are server messages,
 * ids or stack traces. No semicolons or em dashes in this copy.
 */

export const GENERIC_ERROR = "Something went wrong. Try again.";
export const OFFLINE_ERROR = "Could not reach Compute. Check your connection and try again.";
export const SERVER_ERROR = "Compute is having trouble right now. Try again in a minute.";

/** What to offer after the sentence: sign in again through Cloud or Ops, or nothing extra. */
export const NEXT = Object.freeze({ signIn: "sign-in", reauth: "reauth", none: "none" });

export const ERROR_COPY = Object.freeze({
  // Sessions
  unauthorized: "Your session has ended. Open Compute again from SoftQraft.",
  launch_invalid: "This link has expired. Open Compute again from SoftQraft.",
  reauth_required: "Sign in again to continue. For your safety this needs a sign-in from the last 15 minutes.",
  forbidden: "Your role can view but not change this. Ask a project admin for access.",
  cross_origin: "This request did not come from Compute. Reload the page and try again.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",

  // Creating VMs
  quota_exceeded: "There is no room for this size right now. Choose a smaller size or delete a VM you no longer need.",
  name_taken: "A VM with this name already exists. Choose another name.",
  project_not_allowed: "This project cannot create VMs yet. Ask SoftQraft to add it to the pilot.",
  address_pool_exhausted: "No private address is free right now. Delete a VM you no longer need, then try again.",
  unknown_image: "That operating system is not available. Choose another one.",
  disk_too_small: "The disk is too small for this operating system. Choose a larger size.",
  idempotency_key_reused: "That request was already sent. Reload the page to see your VMs.",
  idempotency_key_required: GENERIC_ERROR,
  idempotency_key_invalid: GENERIC_ERROR,
  service_instance_not_found: "Compute is not set up for this project. Open it again from SoftQraft.",
  federation_unknown_instance: "Compute is not set up for this project. Open it again from SoftQraft.",
  federation_instance_disabled: "Compute is turned off for this project. Turn it on in SoftQraft.",

  // VM changes
  invalid_state: "The VM is busy or not in the right state for that. Wait a moment, then try again.",
  concurrent_update: "The VM changed while you were working. Try again.",
  host_disabled: "The server this VM runs on is paused for maintenance. Try again later.",
  no_host_capacity: "The server this VM runs on has no room for that size. Choose a smaller size.",
  invalid_resize: "Choose a size different from the current one. Disks can only grow.",
  snapshot_name_taken: "A snapshot with this name already exists. Choose another name.",
  instance_not_found: "This VM no longer exists. Go back to your VMs.",
  snapshot_not_found: "This snapshot no longer exists. Refresh the page.",
  console_unsupported: "The browser console is not available for this VM. Connect with SSH instead.",
  console_unavailable: "The console could not be opened. Connect with SSH, or try again.",
  console_timeout: "The server did not answer in time. Connect with SSH, or try again.",

  // SSH keys
  ssh_key_invalid: "That does not look like an SSH public key. Paste the contents of your .pub file.",
  ssh_key_private: "That is a private key. Keep it secret and paste the public key from your .pub file instead.",
  ssh_key_unsupported: "Use an ed25519 key, or an RSA key of at least 3072 bits.",
  ssh_key_too_weak: "This RSA key is too short. Use an ed25519 key, or an RSA key of at least 3072 bits.",
  ssh_key_limit: "You have saved as many keys as allowed. Remove one you no longer use.",
  ssh_key_not_found: "This key is no longer saved. Refresh the page.",

  // Fleet
  host_not_found: "This host no longer exists. Refresh the page.",
  host_name_taken: "A host with this name is already enrolled. Choose another name.",

  // Input
  validation_failed: "Check the details and try again.",
  invalid_json: GENERIC_ERROR,
  bad_request: GENERIC_ERROR,
  payload_too_large: "That is too long. Shorten it and try again.",
  unsupported_media_type: GENERIC_ERROR,
  invalid_range: "Choose a shorter period and try again.",
  internal_error: SERVER_ERROR,
  not_found: "This page no longer exists. Go back and try again.",
});

/** The fleet's own wording for a few shared codes. */
const ADMIN_COPY = Object.freeze({
  unauthorized: "Your session has ended. Open the fleet again from Ops.",
  launch_invalid: "This link has expired. Open the fleet again from Ops.",
  forbidden: "Your role can see the fleet but not change it.",
  host_disabled: "This host is disabled. Enable it first.",
  reauth_required: "Sign in again to make changes. For your safety this needs a sign-in from the last 15 minutes.",
});

export class ApiError extends Error {
  /**
   * @param {{ status: number, code?: string }} details
   */
  constructor(details) {
    super("request failed");
    this.name = "ApiError";
    this.status = typeof details?.status === "number" ? details.status : 0;
    /** For branching only. Never shown. */
    this.code = typeof details?.code === "string" ? details.code : "";
  }
}

/**
 * The sentence to show for an error, and what to offer next.
 * @param {unknown} error
 * @param {{ surface?: "console" | "admin" }} [options]
 * @returns {{ message: string, next: string }}
 */
export function presentError(error, options = {}) {
  if (!(error instanceof ApiError)) return { message: GENERIC_ERROR, next: NEXT.none };
  const { status, code } = error;
  const next = code === "reauth_required" ? NEXT.reauth : status === 401 ? NEXT.signIn : NEXT.none;
  if (status === 0) return { message: OFFLINE_ERROR, next };
  if (options.surface === "admin" && Object.hasOwn(ADMIN_COPY, code)) return { message: ADMIN_COPY[code], next };
  if (Object.hasOwn(ERROR_COPY, code)) return { message: ERROR_COPY[code], next };
  if (status === 401) return { message: options.surface === "admin" ? ADMIN_COPY.unauthorized : ERROR_COPY.unauthorized, next };
  if (status >= 500) return { message: SERVER_ERROR, next };
  if (status === 403) return { message: options.surface === "admin" ? ADMIN_COPY.forbidden : ERROR_COPY.forbidden, next };
  if (status === 404) return { message: ERROR_COPY.not_found, next };
  if (status === 409) return { message: ERROR_COPY.concurrent_update, next };
  if (status === 429) return { message: ERROR_COPY.rate_limited, next };
  if (status === 400) return { message: ERROR_COPY.validation_failed, next };
  return { message: GENERIC_ERROR, next };
}
