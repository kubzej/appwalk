import { inspect } from "node:util";

export type LogLevel = "quiet" | "normal" | "verbose" | "debug";
export type LogEventLevel = "info" | "success" | "warn" | "error" | "debug";

export interface LogEvent {
  event: string;
  message: string;
  details?: Record<string, unknown>;
}

const SENSITIVE_KEY = /^(api[-_]?key|authorization|cookie|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|storage(state)?|credential)$/i;
const SENSITIVE_QUERY = /(api[-_]?key|authorization|cookie|password|passwd|secret|token|access_token|refresh_token)/i;

export function redact(value: unknown, key?: string, parentKey?: string): unknown {
  if (key && (SENSITIVE_KEY.test(key) || (parentKey === "input" && (key === "value" || key === "filePaths")))) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      for (const name of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY.test(name)) url.searchParams.set(name, "[REDACTED]");
      }
      return url.toString();
    } catch {
      return value
        .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
        .replace(/(password|passwd|api[_-]?key|token|secret)\s*[:=]\s*([^,\s}]+)/gi, "$1=[REDACTED]");
    }
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, undefined, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey, key)]));
  }
  return value;
}

function formatDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return "";
  return ` ${inspect(redact(details), { depth: 4, breakLength: 140, compact: true, colors: false })}`;
}

export class Logger {
  constructor(
    readonly level: LogLevel = "normal",
    private readonly out: NodeJS.WritableStream = process.stderr,
    private readonly context: Record<string, unknown> = {},
  ) {}

  child(context: Record<string, unknown>): Logger {
    return new Logger(this.level, this.out, { ...this.context, ...context });
  }

  private write(prefix: string, message: string, details?: Record<string, unknown>): void {
    const safeMessage = String(redact(message));
    const combined = { ...this.context, ...details };
    this.out.write(`${prefix}${safeMessage}${formatDetails(Object.keys(combined).length ? combined : undefined)}\n`);
  }

  event(level: LogEventLevel, event: string, message: string, details?: Record<string, unknown>): void {
    if (level === "debug" && this.level !== "debug") return;
    if (level === "info" && this.level === "quiet") return;
    if (level === "success" && this.level === "quiet") return;
    const prefix = level === "debug" ? `[debug] ${event}: ` : "";
    const showDetails = level === "debug" || this.level === "verbose" || this.level === "debug";
    this.write(prefix, message, showDetails ? details : undefined);
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.event("info", "info", message, details);
  }

  success(message: string, details?: Record<string, unknown>): void {
    this.event("success", "success", message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    if (this.level !== "quiet") this.write("", message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.write("Error: ", message, details);
  }

  result(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  verbose(message: string, details?: Record<string, unknown>): void {
    if (this.level === "verbose" || this.level === "debug") this.write("", message, details);
  }

  debug(event: string, message: string, details?: Record<string, unknown>): void {
    this.event("debug", event, message, details);
  }
}

export function logError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
