// What the runner logs through (X-7). The service supplies a file logger; tests and embedders use these two.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  fields: LogFields;
}

const drop = (): void => {};

export const noopLogger: Logger = { debug: drop, info: drop, warn: drop, error: drop };

/** A logger that keeps every entry, for tests. */
export function memoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}): void => {
      entries.push({ level, message, fields: { ...fields } });
    };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
