/**
 * Request and response bodies that are not entities: agent calls, fleet
 * calls, cloud-federation-v1 calls and the error envelope.
 */

import { z } from "zod";
import { ConsoleTicket, DriverName, HostCapacity, HostName, PublicKeyPem, SignedJob } from "./fleet.js";
import { IsoDateTime, Uuid } from "./instance.js";

/** Every error response: `{ "error": { "code", "message", "requestId" } }`. */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** Enrolment token: `sqet_` + 32 random bytes in base64url. */
export const ENROLMENT_TOKEN_RE = /^sqet_[A-Za-z0-9_-]{43}$/;

export const EnrolRequest = z
  .object({
    token: z.string().regex(ENROLMENT_TOKEN_RE),
    name: HostName,
    driver: DriverName,
    publicKey: PublicKeyPem,
    capacity: HostCapacity,
  })
  .strict();
export type EnrolRequest = z.infer<typeof EnrolRequest>;

export const EnrolResponse = z.object({
  hostId: Uuid,
  state: z.literal("enrolled"),
  /** Keys the agent uses to verify job envelopes: `{ keyId: SPKI PEM }`. */
  jobSigningKeys: z.record(z.string()),
});
export type EnrolResponse = z.infer<typeof EnrolResponse>;

export const ClaimResponse = z.object({ job: SignedJob.nullable() });
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const HeartbeatResponse = z.object({ leaseExpiresAt: IsoDateTime });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** Heartbeat and complete name the attempt the agent holds. */
export const JobAttemptRequest = z
  .object({ attempt: z.number().int().min(1) })
  .strict();
export type JobAttemptRequest = z.infer<typeof JobAttemptRequest>;

/**
 * `complete` names the attempt. A `console` job also returns its ticket in
 * `result`; every other job type must leave `result` out.
 */
export const JobCompleteRequest = z
  .object({
    attempt: z.number().int().min(1),
    result: ConsoleTicket.optional(),
  })
  .strict();
export type JobCompleteRequest = z.infer<typeof JobCompleteRequest>;

export const JobFailRequest = z
  .object({
    attempt: z.number().int().min(1),
    /** A short, secret-free reason. */
    error: z.string().min(1).max(500),
  })
  .strict();
export type JobFailRequest = z.infer<typeof JobFailRequest>;

/** Enrolment tokens are valid once and expire after 30 minutes. */
export const ENROLMENT_TOKEN_TTL_SECONDS = 1800;

export const CreateEnrolmentTokenRequest = z
  .object({
    /** When set, the token enrols only a host with this name. */
    hostName: HostName.optional(),
  })
  .strict();
export type CreateEnrolmentTokenRequest = z.infer<typeof CreateEnrolmentTokenRequest>;

export const CreateEnrolmentTokenResponse = z.object({
  /** Shown once. The API stores only its SHA-256 hash. */
  token: z.string().regex(ENROLMENT_TOKEN_RE),
  hostName: HostName.nullable(),
  expiresAt: IsoDateTime,
});
export type CreateEnrolmentTokenResponse = z.infer<typeof CreateEnrolmentTokenResponse>;

// ---------------------------------------------------------------------------
// cloud-federation-v1 (§3, §8): bodies Cloud sends to Compute
// ---------------------------------------------------------------------------

/** Clerk subjects such as `user_…`: printable ASCII without spaces, as Media accepts them. */
export const PRINCIPAL_SUBJECT_RE = /^[\x21-\x7e]{1,255}$/;
export const RETURN_PATH_MAX_LENGTH = 512;

/** §3.1 provision or look up a service instance. */
export const ProvisionServiceInstanceRequest = z.object({
  cloudOrganisationId: Uuid,
  cloudProjectId: Uuid,
  displayName: z.string().trim().min(1).max(120),
  regionId: z.string().min(1).max(64),
});
export type ProvisionServiceInstanceRequest = z.infer<typeof ProvisionServiceInstanceRequest>;

/** §3.2 and §8.2: display data only, never used for ownership. */
export const CloudPrincipal = z.object({
  subject: z.string().regex(PRINCIPAL_SUBJECT_RE),
  displayName: z.string().trim().max(120),
  email: z.string().trim().max(254),
});
export type CloudPrincipal = z.infer<typeof CloudPrincipal>;

/** Customer roles a Console launch asserts (§3.2). */
export const CONSOLE_ROLES = Object.freeze(["admin", "developer", "viewer"] as const);
export const ConsoleRole = z.enum(CONSOLE_ROLES);
export type ConsoleRole = z.infer<typeof ConsoleRole>;

/** Platform operator roles an operator launch asserts (§8.2). */
export const OPERATOR_ROLES = Object.freeze(["owner", "admin", "viewer"] as const);
export const OperatorRole = z.enum(OPERATOR_ROLES);
export type OperatorRole = z.infer<typeof OperatorRole>;

/** §3.2 Console launch. */
export const ConsoleLaunchRequest = z.object({
  principal: CloudPrincipal,
  role: ConsoleRole,
  returnPath: z.string().max(RETURN_PATH_MAX_LENGTH),
});
export type ConsoleLaunchRequest = z.infer<typeof ConsoleLaunchRequest>;

/** §8.2 operator launch. */
export const OperatorLaunchRequest = z.object({
  principal: CloudPrincipal,
  role: OperatorRole,
  returnPath: z.string().max(RETURN_PATH_MAX_LENGTH),
});
export type OperatorLaunchRequest = z.infer<typeof OperatorLaunchRequest>;

/** §3.2 and §8.2 response. */
export const LaunchResponse = z.object({ launchUrl: z.string().url(), expiresAt: IsoDateTime });
export type LaunchResponse = z.infer<typeof LaunchResponse>;
