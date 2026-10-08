/**
 * Stable, secret-free error codes. Every failure the Proxmox driver reports
 * is a DriverError with one of these codes (or a shared DRIVER_ERRORS code),
 * and a message that never contains a token, header, body or parameter value.
 */

import { DRIVER_ERRORS, DriverError } from "@softqraft/compute-driver";

export const PROXMOX_ERRORS = Object.freeze({
  ...DRIVER_ERRORS,
  /** The API could not be reached (connection refused, reset, timeout). Retryable. */
  unreachable: "proxmox_unreachable",
  /** The API certificate does not match PROXMOX_TLS_FINGERPRINT. Nothing was sent. */
  tlsPinMismatch: "proxmox_tls_pin_mismatch",
  /** 401: the token was refused. */
  auth: "proxmox_auth",
  /** 403: the token lacks a privilege. */
  forbidden: "proxmox_forbidden",
  /** Another 4xx: Proxmox refused the parameters. */
  rejected: "proxmox_rejected",
  /** 5xx. Retryable. */
  server: "proxmox_server_error",
  /** The response was not the JSON Proxmox sends. */
  badResponse: "proxmox_bad_response",
  /** A task ended with an error. */
  taskFailed: "proxmox_task_failed",
  /** A task did not end in time. Retryable. */
  taskTimeout: "proxmox_task_timeout",
  /** A call outside the fences (VMID range, pool, storage, bridge, node, endpoint). Nothing was sent. */
  fenceRefused: "proxmox_fence_refused",
  /** No free VMID in COMPUTE_VMID_RANGE. */
  vmidExhausted: "proxmox_vmid_exhausted",
  /** The image's template VM does not exist yet. Retryable (ensureImages creates it). */
  imageUnavailable: "image_unavailable",
  /** The image is not in the catalogue. */
  unknownImage: "unknown_image",
  /** The vendor checksum could not be fetched or did not list the image. */
  imageChecksum: "image_checksum_unavailable",
  /** Proxmox cannot hold a snapshot with this name (one character, or `current`). */
  snapshotName: "snapshot_name_unsupported",
  /** The job's address or network is not one the driver may configure. */
  network: "network_refused",
} as const);

export type ProxmoxErrorCode = (typeof PROXMOX_ERRORS)[keyof typeof PROXMOX_ERRORS];

export function proxmoxError(code: ProxmoxErrorCode, message: string, retryable = false): DriverError {
  return new DriverError(code, message, retryable);
}

export function fenceRefused(what: string): DriverError {
  return proxmoxError(PROXMOX_ERRORS.fenceRefused, `Refused before sending: ${what}`);
}

/** Where the agent's `proxmox_tls_pin_mismatch` line sends the operator. */
export const REPIN_DOC_URL =
  "https://github.com/imp213x/softqraft-compute/blob/main/docs/host-agent.md#re-pin-after-a-certificate-change";

/**
 * The API certificate does not match PROXMOX_TLS_FINGERPRINT. It carries both
 * fingerprints so the agent can say what to change: they are public
 * certificate data, never a secret.
 */
export class TlsPinMismatchError extends DriverError {
  constructor(
    readonly pinnedFingerprint: string,
    readonly presentedFingerprint: string,
  ) {
    super(PROXMOX_ERRORS.tlsPinMismatch, "The Proxmox API certificate does not match the pinned fingerprint", false);
  }
}
