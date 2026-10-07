/**
 * Structured logs: one JSON object per line on stdout (journald keeps them).
 *
 * Belt and braces: any field whose name suggests a credential, a key, a
 * signature or an envelope is replaced, and string values that look like a
 * token are masked, before anything is written. Callers still never pass
 * such values on purpose.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SECRET_FIELD = /token|secret|password|passwd|signature|envelope|authorization|cookie|ticket|pem|private|credential|^key$|keys$/i;
const SECRET_VALUE = /(PVEAPIToken=\S+|sqet_[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*KEY-----[\s\S]*?-----END [A-Z ]*KEY-----)/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELD.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  level: LogLevel | "silent",
  write: (line: string) => void = (line) => process.stdout.write(line),
  clock: () => Date = () => new Date(),
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry = { time: clock().toISOString(), level: lvl, msg, ...(redact(fields) as Record<string, unknown>) };
    write(`${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
