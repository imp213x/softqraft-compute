/** Path parameter checks shared by the route files. */

import type { FastifyRequest } from "fastify";
import { HttpError } from "./errors.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A UUID path parameter, lower-cased. Anything else is a 404, as if unrouted. */
export function uuidParam(req: FastifyRequest, name: string, what: string): string {
  const value = (req.params as Record<string, string | undefined>)[name];
  if (!value || !UUID_RE.test(value)) throw new HttpError(404, `${what}_not_found`, `${capitalise(what)} not found`);
  return value.toLowerCase();
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
