/**
 * Raw body capture and JSON parsing.
 *
 * Signed routes (Cloud and agent) hash the exact request bytes, so bodies
 * are captured raw before any parsing and parsed only after the signature
 * has been checked.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { HttpError } from "./errors.js";

/** Every request body is a small JSON document. */
export const MAX_BODY_BYTES = 64 * 1024;

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** Capture the exact body bytes of every request into `req.rawBody`. */
export function registerRawBody(app: FastifyInstance): void {
  app.addHook("preParsing", async (request, _reply, payload) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
      }
      chunks.push(buf);
    }
    const buf = Buffer.concat(chunks);
    request.rawBody = buf;
    return Readable.from(buf);
  });
  // Bodies are parsed by the handlers (after verification), never by Fastify.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES }, (_req, _body, done) =>
    done(null, undefined),
  );
}

/** Parse the raw body as JSON. An empty body is `{}`. */
export function jsonBody(req: FastifyRequest): unknown {
  const text = req.rawBody ? req.rawBody.toString("utf8") : "";
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON");
  }
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
