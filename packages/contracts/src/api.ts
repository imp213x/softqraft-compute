/**
 * Request and response bodies that are not entities: agent calls, fleet
 * calls and the error envelope.
 */

import { z } from "zod";
import { DriverName, HostCapacity, HostName, PublicKeyPem, SignedJob } from "./fleet.js";
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

export const JobCompleteRequest = z
  .object({ attempt: z.number().int().min(1) })
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

export const CreateEnrolmentTokenRequest = z
  .object({
    hostName: HostName.optional(),
    ttlSeconds: z.number().int().min(60).max(86400).optional(),
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
