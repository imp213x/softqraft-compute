/**
 * Return-path validation (contract §3.2, §7.2, §8.2).
 *
 * Generalises Media's `isSafeReturnPath` (which is this function with
 * basePath "/console" and no forbidden prefixes). A path is accepted only
 * when all of these hold:
 * - it is a string of at most 512 characters;
 * - it starts with `basePath + "/"`;
 * - it contains no `//` and no `\`;
 * - it contains no control characters, space, DEL or C1 characters;
 * - it contains no percent-encoded `.`, `/`, `\` or NUL (%2e %2f %5c %00);
 * - the WHATWG URL parser, resolving it against a fixed origin, keeps that
 *   origin and changes nothing. This rejects schemes, hosts, dot segments
 *   (`/admin/../console`, `/admin/./x`) and anything the parser would
 *   re-encode;
 * - its path part is not under any forbidden prefix (case-insensitive;
 *   `/admin/v1/` also forbids `/admin/v1` itself).
 */

export const RETURN_PATH_MAX_LENGTH = 512;

export interface ReturnPathOptions {
  /** e.g. "/console" or "/admin". Must start with "/" and not end with one. */
  basePath: string;
  /** e.g. ["/admin/v1/"]. Paths at or under these are rejected. */
  forbiddenPrefixes?: readonly string[];
}

const BASE_PATH_RE = /^(\/[A-Za-z0-9._~-]+)+$/;
const CONTROL_RE = /[\u0000- \u007f-\u009f]/;
const ENCODED_SEPARATOR_RE = /%(2e|2f|5c|00)/i;
const PARSE_BASE = "https://return-path.invalid";

function isUnderPrefix(pathname: string, prefix: string): boolean {
  const lowerPath = pathname.toLowerCase();
  const stem = (prefix.endsWith("/") ? prefix.slice(0, -1) : prefix).toLowerCase();
  if (stem === "") return true; // "/" forbids everything
  return lowerPath === stem || lowerPath.startsWith(`${stem}/`);
}

/** True when `path` is a safe relative return path under `options.basePath`. */
export function validateReturnPath(path: unknown, options: ReturnPathOptions): boolean {
  const basePath = options.basePath;
  if (typeof basePath !== "string" || !BASE_PATH_RE.test(basePath)) return false;
  const root = `${basePath}/`;
  if (
    typeof path !== "string" ||
    path.length > RETURN_PATH_MAX_LENGTH ||
    !path.startsWith(root) ||
    path.includes("//") ||
    path.includes("\\") ||
    CONTROL_RE.test(path) ||
    ENCODED_SEPARATOR_RE.test(path)
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(path, PARSE_BASE);
  } catch {
    return false;
  }
  if (
    url.origin !== PARSE_BASE ||
    !url.pathname.startsWith(root) ||
    `${url.pathname}${url.search}${url.hash}` !== path
  ) {
    return false;
  }
  for (const prefix of options.forbiddenPrefixes ?? []) {
    if (typeof prefix !== "string" || isUnderPrefix(url.pathname, prefix)) return false;
  }
  return true;
}
