/**
 * Minimal leveled logger.
 *
 * Writes to stderr (never stdout) so it can never corrupt protocol output —
 * which matters the day someone runs this over stdio. Level is set by the
 * LOG_LEVEL env var (error | warn | info | debug), default "info". Set
 * LOG_LEVEL=silent to mute (e.g. in tests).
 */

type Level = "error" | "warn" | "info" | "debug";

const ORDER: Record<Level | "silent", number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return ORDER[raw as Level | "silent"] ?? ORDER.info;
}

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  if (ORDER[level] > threshold()) return;
  const time = new Date().toISOString();
  const tail =
    fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  process.stderr.write(`${time} ${level.toUpperCase()} ${message}${tail}\n`);
}

export const log = {
  error: (message: string, fields?: Record<string, unknown>) =>
    emit("error", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) =>
    emit("warn", message, fields),
  info: (message: string, fields?: Record<string, unknown>) =>
    emit("info", message, fields),
  debug: (message: string, fields?: Record<string, unknown>) =>
    emit("debug", message, fields),
};
