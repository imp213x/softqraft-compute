/**
 * Canonical JSON: one byte sequence for one value, so a signature made by
 * the API verifies on the agent whatever order the fields arrive in.
 *
 * Rules (a subset of RFC 8785, enough for job envelopes):
 * - object keys sorted by UTF-16 code unit, as `Array.prototype.sort` does;
 * - no whitespace;
 * - strings and numbers serialised as `JSON.stringify` does;
 * - only plain objects, arrays, strings, finite numbers, booleans and null.
 *   `undefined`, functions, symbols, bigint, NaN, Infinity, Dates and other
 *   class instances throw, so a value never changes silently on the wire.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalJson(value: unknown): string {
  return serialise(value, 0);
}

const MAX_DEPTH = 32;

function serialise(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError("canonicalJson: value is nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: numbers must be finite");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialise(item, depth + 1)).join(",")}]`;
      }
      if (!isPlainObject(value)) {
        throw new TypeError("canonicalJson: only plain objects are allowed");
      }
      const entries = Object.keys(value)
        .sort()
        .map((key) => {
          const item = (value as Record<string, unknown>)[key];
          return `${JSON.stringify(key)}:${serialise(item, depth + 1)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not allowed`);
  }
}
