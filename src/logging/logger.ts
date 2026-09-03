import { inspect } from "node:util";
import { Redactor } from "../security/redaction.js";

export { redact } from "../security/redaction.js";

export type LogLevel = "quiet" | "normal" | "verbose" | "debug";
export type LogEventLevel = "info" | "success" | "warn" | "error" | "debug";
type LogTone = "phase" | "success" | "warn" | "error" | "muted" | "debug";

export interface LoggerOptions {
  /** Override automatic TTY detection, primarily for tests and embedders. */
  color?: boolean;
  /** Shared data policy used for messages and structured diagnostic details. */
  redactor?: Redactor;
}

export interface LogEvent {
  event: string;
  message: string;
  details?: Record<string, unknown>;
}

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ENCODED_ANSI_ESCAPE = /%1b\[[0-?]*[ -/]*[@-~]/gi;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(ENCODED_ANSI_ESCAPE, "");
}

function formatDetails(details: Record<string, unknown> | undefined, redactor: Redactor): string {
  if (!details) return "";
  const rendered = stripAnsi(inspect(redactor.redact(details), { depth: 4, breakLength: 140, compact: true, colors: false }));
  if (!rendered.includes("\n")) return ` ${rendered}`;
  return `\n${rendered.split("\n").map((line) => `  ${line}`).join("\n")}`;
}

function streamSupportsColor(out: NodeJS.WritableStream): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return Boolean((out as NodeJS.WritableStream & { isTTY?: boolean }).isTTY);
}

function paint(value: string, tone: LogTone, enabled: boolean): string {
  if (!enabled) return value;
  const color = {
    phase: "\u001b[36;1m",
    success: "\u001b[32m",
    warn: "\u001b[33m",
    error: "\u001b[31;1m",
    muted: "\u001b[90m",
    debug: "\u001b[90m",
  }[tone];
  return `${color}${value}\u001b[0m`;
}

function paintResult(value: string, enabled: boolean): string {
  if (!enabled) return value;
  return value.split("\n").map((line) => {
    if (line === "done:" || line.startsWith("summary:")) return paint(line, "phase", enabled);
    if (/^No confirmed regression flow|^status: inconclusive/i.test(line)) return paint(line, "warn", enabled);
    if (/^(test suite|fixtures):/i.test(line)) return paint(line, "success", enabled);
    return line;
  }).join("\n");
}

export class Logger {
  private readonly colorEnabled: boolean;
  private readonly redactor: Redactor;

  constructor(
    readonly level: LogLevel = "normal",
    private readonly out: NodeJS.WritableStream = process.stderr,
    private readonly context: Record<string, unknown> = {},
    options: LoggerOptions = {},
  ) {
    this.colorEnabled = options.color ?? streamSupportsColor(out);
    this.redactor = options.redactor ?? new Redactor();
  }

  child(context: Record<string, unknown>): Logger {
    return new Logger(this.level, this.out, { ...this.context, ...context }, { color: this.colorEnabled, redactor: this.redactor });
  }

  private write(message: string, details?: Record<string, unknown>, tone?: LogTone, prefix = "", includeContext = true): void {
    const safeMessage = stripAnsi(this.redactor.text(message));
    const combined = includeContext ? { ...this.context, ...details } : details ?? {};
    const line = `${prefix}${safeMessage}${formatDetails(Object.keys(combined).length ? combined : undefined, this.redactor)}`;
    this.out.write(tone ? paint(line, tone, this.colorEnabled) + "\n" : `${line}\n`);
  }

  event(level: LogEventLevel, event: string, message: string, details?: Record<string, unknown>): void {
    if (level === "debug" && this.level !== "debug") return;
    if (level === "info" && this.level === "quiet") return;
    if (level === "success" && this.level === "quiet") return;
    const prefix = level === "debug" ? `[debug] ${event}: ` : "";
    const showDetails = level === "debug" || this.level === "verbose" || this.level === "debug";
    const tone = level === "success" || level === "warn" || level === "error" || level === "debug"
      ? level
      : undefined;
    this.write(message, showDetails ? details : undefined, tone, prefix, level === "debug");
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.event("info", "info", message, details);
  }

  success(message: string, details?: Record<string, unknown>): void {
    this.event("success", "success", message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    if (this.level !== "quiet") this.event("warn", "warning", message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.event("error", "error", message, details);
  }

  result(message: string): void {
    process.stdout.write(`${paintResult(message, streamSupportsColor(process.stdout))}\n`);
  }

  verbose(message: string, details?: Record<string, unknown>): void {
    if (this.level === "verbose" || this.level === "debug") this.write(message, details, "muted", "", this.level === "debug");
  }

  actionFailure(message: string, details?: Record<string, unknown>): void {
    if (this.level === "quiet") return;
    const detailed = this.level === "verbose" || this.level === "debug" ? details : undefined;
    this.write(message, detailed, this.level === "normal" ? "warn" : "muted", "", this.level === "debug");
  }

  phase(message: string, details?: Record<string, unknown>): void {
    if (this.level !== "quiet") this.write(message, this.level === "verbose" || this.level === "debug" ? details : undefined, "phase", "", this.level === "debug");
  }

  debug(event: string, message: string, details?: Record<string, unknown>): void {
    this.event("debug", event, message, details);
  }
}

export function logError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
