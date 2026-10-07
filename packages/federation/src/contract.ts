/**
 * cloud-federation-v1 platform constants (contract §2, §3, §5, §7, §8, §9).
 *
 * Everything here is data. Nothing in this package logs, and callers must
 * never log grants, session tokens, signatures, keys or raw bodies.
 */

export const CONTRACT_NAME = "cloud-federation-v1";

/** First line of the canonical string (contract §2). v2 would be `SQCF2`. */
export const CANONICAL_PREFIX = "SQCF1";

/**
 * Signed-request header names, in the canonical casing Cloud sends.
 * Lookup on the verifying side is case-insensitive.
 */
export const HEADERS = Object.freeze({
  keyId: "X-SQ-Cloud-Key-Id",
  timestamp: "X-SQ-Cloud-Timestamp",
  nonce: "X-SQ-Cloud-Nonce",
  signature: "X-SQ-Cloud-Signature",
} as const);

/** Lowercase header names, as Node's HTTP stack presents them. */
export const HEADERS_LOWER = Object.freeze({
  keyId: "x-sq-cloud-key-id",
  timestamp: "x-sq-cloud-timestamp",
  nonce: "x-sq-cloud-nonce",
  signature: "x-sq-cloud-signature",
} as const);

/** `|now − timestamp| ≤ 60s` is accepted (inclusive). */
export const CLOCK_SKEW_SECONDS = 60;
/** A nonce is remembered for 300s after a successful verification. */
export const NONCE_TTL_SECONDS = 300;
/** Console (`sqlg_`) and operator (`sqog_`) grants live 60s. */
export const GRANT_TTL_SECONDS = 60;
/** Link grants (`sqlk_`) live 10 minutes (contract §7.2). */
export const LINK_GRANT_TTL_SECONDS = 600;
/** Operator sessions: 1 hour absolute, no sliding (contract §8.4). */
export const OPERATOR_SESSION_TTL_SECONDS = 3600;
/** Cloud Console sessions: 8 hours absolute (contract §4). */
export const CONSOLE_SESSION_TTL_SECONDS = 28800;
/** Privileged writes need a session younger than 15 minutes (§5, §8.4). */
export const FRESH_WRITE_SECONDS = 900;

export const GRANT_PREFIX = Object.freeze({
  console: "sqlg_",
  link: "sqlk_",
  operator: "sqog_",
} as const);
export type GrantKind = keyof typeof GRANT_PREFIX;
export const GRANT_KINDS: readonly GrantKind[] = Object.freeze([
  "console",
  "link",
  "operator",
]);

export const SESSION_PREFIX = Object.freeze({
  console: "sqcs_",
  operator: "sqos_",
} as const);
export type SessionKind = keyof typeof SESSION_PREFIX;
export const SESSION_KINDS: readonly SessionKind[] = Object.freeze([
  "console",
  "operator",
]);

/** Platform operator vocabulary (contract §8.2, brief D3). */
export const OPERATOR_ROLES = Object.freeze(["owner", "admin", "viewer"] as const);
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** Cloud project roles asserted on a Console launch (contract §3.2). */
export const CONSOLE_ROLES = Object.freeze(["admin", "developer", "viewer"] as const);
export type ConsoleRole = (typeof CONSOLE_ROLES)[number];

/** Error codes defined by the contract. Values are the wire codes. */
export const ERROR_CODES = Object.freeze({
  // §2 signed requests
  MALFORMED: "federation_malformed",
  UNKNOWN_KEY: "federation_unknown_key",
  STALE: "federation_stale",
  SIGNATURE: "federation_signature",
  REPLAY: "federation_replay",
  // §3 endpoints
  LINK_CONFLICT: "federation_link_conflict",
  UNKNOWN_INSTANCE: "federation_unknown_instance",
  INSTANCE_DISABLED: "federation_instance_disabled",
  RETURN_PATH: "federation_return_path",
  // §4, §5, §8.3, §8.4
  LAUNCH_INVALID: "launch_invalid",
  MANAGED_BY_CLOUD: "managed_by_cloud",
  REAUTH_REQUIRED: "reauth_required",
  // §7 (F3)
  LINK_INVALID: "link_invalid",
  INVALID_CREDENTIALS: "invalid_credentials",
  NO_WORKSPACE: "no_workspace",
  TENANT_ALREADY_LINKED: "federation_tenant_already_linked",
  PASSWORD_LOGIN_RETIRED: "password_login_retired",
  SIGNUP_CLOSED: "signup_closed",
  // F5 Cloud-side (brief §6, Agent B)
  OPERATOR_LAUNCH_FORBIDDEN: "operator_launch_forbidden",
} as const);
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Verification failure reasons, in contract §2 check order. */
export const VERIFY_FAILURES = Object.freeze([
  "malformed",
  "unknown_key",
  "stale",
  "signature",
  "replay",
] as const);
export type VerifyFailure = (typeof VERIFY_FAILURES)[number];

export interface FailureResponse {
  status: number;
  code: ErrorCode;
  message: string;
}

/** §2 failure → HTTP status, wire code and a secret-free message. */
export const FAILURE_RESPONSES: Readonly<Record<VerifyFailure, FailureResponse>> =
  Object.freeze({
    malformed: {
      status: 400,
      code: ERROR_CODES.MALFORMED,
      message: "Signed request headers are missing or malformed",
    },
    unknown_key: {
      status: 401,
      code: ERROR_CODES.UNKNOWN_KEY,
      message: "Unknown signing key",
    },
    stale: {
      status: 401,
      code: ERROR_CODES.STALE,
      message: "Signed request timestamp is outside the allowed window",
    },
    signature: {
      status: 401,
      code: ERROR_CODES.SIGNATURE,
      message: "Signed request signature is invalid",
    },
    replay: {
      status: 401,
      code: ERROR_CODES.REPLAY,
      message: "Signed request nonce was already used",
    },
  });

/** Other contract responses a service returns, for convenience. */
export const CONTRACT_RESPONSES = Object.freeze({
  returnPath: { status: 400, code: ERROR_CODES.RETURN_PATH },
  launchInvalid: { status: 401, code: ERROR_CODES.LAUNCH_INVALID },
  linkInvalid: { status: 401, code: ERROR_CODES.LINK_INVALID },
  reauthRequired: { status: 403, code: ERROR_CODES.REAUTH_REQUIRED },
  operatorLaunchForbidden: { status: 403, code: ERROR_CODES.OPERATOR_LAUNCH_FORBIDDEN },
} as const);

/** Security event names recorded by services (§4, §7.3, §8.3, §8.4). */
export const SECURITY_EVENTS = Object.freeze({
  cloudLaunch: "auth.cloud_launch",
  linkedToCloud: "auth.linked_to_cloud",
  operatorLaunch: "auth.operator_launch",
  operatorReauthRequired: "auth.operator_reauth_required",
} as const);

/** Signed endpoint paths every service implements (§3, §8). */
export const ENDPOINTS = Object.freeze({
  operatorLaunches: "/cloud/v1/operator-launches",
} as const);
