/**
 * HTTP errors and the error envelope `{ error: { code, message, requestId } }`.
 * Messages are written for API callers and never contain secrets.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Turn a zod error into a 400 that names the fields, never their values. */
export function validationError(err: ZodError): HttpError {
  const fields = [...new Set(err.issues.map((i) => i.path.join(".") || "(body)"))].slice(0, 5);
  return new HttpError(400, "validation_failed", `Invalid request: ${fields.join(", ")}`);
}

export function toHttpError(err: unknown): HttpError | null {
  if (err instanceof HttpError) return err;
  if (err instanceof ZodError) return validationError(err);
  const status = (err as { statusCode?: unknown })?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const code = status === 413 ? "payload_too_large" : status === 415 ? "unsupported_media_type" : "bad_request";
    return new HttpError(status, code, status === 413 ? "Request body is too large" : "Bad request");
  }
  return null;
}

export function sendError(req: FastifyRequest, reply: FastifyReply, err: HttpError): FastifyReply {
  return reply
    .status(err.statusCode)
    .send({ error: { code: err.code, message: err.message, requestId: String(req.id) } });
}
