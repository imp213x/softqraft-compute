/** Internal: time inputs accepted by the policy functions. */

export type TimeInput = Date | string;

/** Epoch milliseconds, or NaN for anything that is not a valid Date or ISO-8601 string. */
export function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value.length > 0) return Date.parse(value);
  return Number.NaN;
}
