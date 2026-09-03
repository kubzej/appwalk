import { inspect } from "node:util";
import { Redactor } from "../security/redaction.js";

/**
 * Every line this Logger writes follows one fixed anatomy, in this order:
 *
 *   <indent> <persona badge?> <message> <details?>
 *
 * No status glyphs (checkmarks, arrows, warning signs) anywhere — color and weight alone carry
 * meaning, so nothing has to render as "sometimes an icon, sometimes not". The rules that
 * assemble a line are mechanical, not per-call-site choices:
 *
 * - Indent is `depth * 2 spaces`, where depth only comes from `child()` nesting (run -> flow ->
 *   scenario). No method ever hand-formats leading whitespace into a message string.
 * - The `[persona]` badge appears on every line once a scope has a persona in context (via
 *   `child({ persona })`) — never on some of that scope's lines and not others. It is always the
 *   same fixed color, deliberately not one of the tone colors below, so a badge is never
 *   mistaken for a status.
 * - Color is the only status signal, and only four tones count as a status: `phase` cyan,
 *   `success` green, `warn` yellow, `error` red — all regular weight, never bold. `verbose`/
 *   `debug` get a neutral muted gray (still colored, so structured detail stays visually distinct
 *   from a plain line, but never one of the four status colors). `info` carries no tone at all —
 *   the terminal's plain default color. All of it is supporting detail, read top-to-bottom, not
 *   scanned for status.
 * - Bold is never part of a tone. It is used standalone, only for a panel's own title (e.g.
 *   "Configuration", "Summary" — see terminal-summary.ts), never for a regular log line.
 * - `task()` (the spinner) renders the exact same anatomy as any other line. The animated braille
 *   frame during the wait is motion, not a status glyph, and disappears once the line resolves to
 *   its final success/error color. It is only ever used to wrap an operation that prints nothing
 *   else while it's pending (e.g. launching the browser) — exploring/replaying instead keep using
 *   a plain `phase()` header, because their own stream of nested lines is already the progress
 *   indicator; layering a spinner on top would fight it.
 *
 * Changing any of this should change the rule here, not patch one call site's formatting.
 */
export { redact } from "../security/redaction.js";

export type LogLevel = "quiet" | "normal" | "verbose" | "debug";
export type LogEventLevel = "info" | "success" | "warn" | "error" | "debug";
export type LogTone = "phase" | "success" | "warn" | "error" | "muted" | "debug";

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
const RESET = "\u001b[0m";
const INDENT_UNIT = "  ";

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(ENCODED_ANSI_ESCAPE, "");
}

function formatDetails(details: Record<string, unknown> | undefined, redactor: Redactor): string {
  if (!details) return "";
  const rendered = stripAnsi(inspect(redactor.redact(details), { depth: 4, breakLength: 140, compact: true, colors: false }));
  if (!rendered.includes("\n")) return ` ${rendered}`;
  return `\n${rendered.split("\n").map((line) => `  ${line}`).join("\n")}`;
}

export function streamSupportsColor(out: NodeJS.WritableStream): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return Boolean((out as NodeJS.WritableStream & { isTTY?: boolean }).isTTY);
}

const TONE_COLOR: Record<LogTone, string> = {
  phase: "\u001b[36m",
  success: "\u001b[32m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
  muted: "\u001b[90m",
  debug: "\u001b[90m",
};

// One fixed color for every persona badge -- deliberately not cyan/green/yellow/red/gray,
// since those are TONE_COLOR's hues and a badge must never be confusable with a status tone.
const PERSONA_BADGE_COLOR = "\u001b[35m";

export function paint(value: string, tone: LogTone, enabled: boolean): string {
  if (!enabled) return value;
  return `${TONE_COLOR[tone]}${value}${RESET}`;
}

export function dim(value: string, enabled: boolean): string {
  return enabled ? `\u001b[2m${value}\u001b[22m` : value;
}

export function bold(value: string, enabled: boolean): string {
  return enabled ? `\u001b[1m${value}\u001b[22m` : value;
}

// A filled color "chip" around a panel title (cyan background, dark text) -- this is the one
// place bold/icons would have gone; a filled background reads as "section boundary" without
// either, and without NO_COLOR it degrades to a plain bracketed label.
export function chip(text: string, enabled: boolean): string {
  if (!enabled) return `[${text}]`;
  return `\u001b[46m\u001b[30m ${text} \u001b[0m`;
}

/** Formats a duration for end-of-task timing, e.g. "320ms", "4.2s", "1m 05s". */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** A single-line, in-place spinner. Only meaningful on a color-capable TTY; callers fall back to
 * a plain start/finish line otherwise so redirected output never fills up with carriage returns. */
class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** `prefix` (indentation + persona badge) always precedes the status glyph, matching every
   * other Logger line -- only the glyph itself (spinner frame, then success/fail) changes as work runs. */
  constructor(private readonly out: NodeJS.WritableStream, private readonly prefix: string, private readonly label: string) {}

  start(): void {
    this.render();
    this.timer = setInterval(() => this.render(), SPINNER_INTERVAL_MS);
    this.timer.unref?.();
  }

  private render(): void {
    const frame = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
    this.frame += 1;
    this.out.write(`\r\u001b[K${this.prefix}${TONE_COLOR.phase}${frame}${RESET} ${this.label}`);
  }

  private clear(finalLine: string): void {
    if (this.timer) clearInterval(this.timer);
    this.out.write(`\r\u001b[K${finalLine}\n`);
  }

  succeed(suffix: string): void {
    this.clear(`${this.prefix}${paint(this.label, "success", true)} ${dim(suffix, true)}`);
  }

  fail(suffix: string): void {
    this.clear(`${this.prefix}${paint(this.label, "error", true)} ${dim(suffix, true)}`);
  }
}

export class Logger {
  private readonly colorEnabled: boolean;
  private readonly redactor: Redactor;
  private readonly depth: number;

  constructor(
    readonly level: LogLevel = "normal",
    private readonly out: NodeJS.WritableStream = process.stderr,
    private readonly context: Record<string, unknown> = {},
    options: LoggerOptions = {},
    depth = 0,
  ) {
    this.colorEnabled = options.color ?? streamSupportsColor(out);
    this.redactor = options.redactor ?? new Redactor();
    this.depth = depth;
  }

  /** Every child scope (a run, a flow, a derived scenario) is one level of visual nesting —
   * indentation and badges are derived from this, so call sites never hand-format whitespace. */
  child(context: Record<string, unknown>): Logger {
    return new Logger(this.level, this.out, { ...this.context, ...context }, { color: this.colorEnabled, redactor: this.redactor }, this.depth + 1);
  }

  private indent(): string {
    return INDENT_UNIT.repeat(this.depth);
  }

  private badge(): string {
    const persona = this.context.persona;
    if (typeof persona !== "string" || !persona) return "";
    if (!this.colorEnabled) return `[${persona}] `;
    return `${PERSONA_BADGE_COLOR}[${persona}]${RESET} `;
  }

  private write(message: string, details?: Record<string, unknown>, tone?: LogTone, prefix = "", includeContext = true): void {
    const safeMessage = stripAnsi(this.redactor.text(message));
    const combined = includeContext ? { ...this.context, ...details } : details ?? {};
    const detailsStr = formatDetails(Object.keys(combined).length ? combined : undefined, this.redactor);
    const body = `${prefix}${safeMessage}`;
    const styledBody = tone ? paint(body, tone, this.colorEnabled) : body;
    this.out.write(`${this.indent()}${this.badge()}${styledBody}${detailsStr}\n`);
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

  verbose(message: string, details?: Record<string, unknown>): void {
    if (this.level === "verbose" || this.level === "debug") this.write(message, details, "muted", "", this.level === "debug");
  }

  actionFailure(message: string, details?: Record<string, unknown>): void {
    if (this.level === "quiet") return;
    const detailed = this.level === "verbose" || this.level === "debug" ? details : undefined;
    this.write(message, detailed, this.level === "normal" ? "warn" : "muted", "", this.level === "debug");
  }

  /** A section header. */
  phase(message: string, details?: Record<string, unknown>): void {
    if (this.level !== "quiet") this.write(message, this.level === "verbose" || this.level === "debug" ? details : undefined, "phase", "", this.level === "debug");
  }

  debug(event: string, message: string, details?: Record<string, unknown>): void {
    this.event("debug", event, message, details);
  }

  /**
   * Runs a long operation under a phase header, showing a live spinner while it's pending.
   * Only spinners while nothing else is expected to print concurrently — callers that emit
   * their own nested log lines during the operation (exploring, replaying) should keep using
   * a plain `phase()` header instead, so the spinner's carriage-return updates never collide
   * with other output.
   */
  async task<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.level === "quiet") return fn();
    const prefix = `${this.indent()}${this.badge()}`;
    const useSpinner = this.colorEnabled && this.level !== "debug";
    const spinner = useSpinner ? new Spinner(this.out, prefix, label) : undefined;
    if (spinner) spinner.start();
    else this.out.write(`${prefix}${label}\n`);
    const startedAt = Date.now();
    try {
      const result = await fn();
      const elapsed = formatElapsed(Date.now() - startedAt);
      if (spinner) spinner.succeed(elapsed);
      else this.out.write(`${prefix}${paint(label, "success", this.colorEnabled)} ${dim(elapsed, this.colorEnabled)}\n`);
      return result;
    } catch (error) {
      const elapsed = formatElapsed(Date.now() - startedAt);
      if (spinner) spinner.fail(elapsed);
      else this.out.write(`${prefix}${paint(label, "error", this.colorEnabled)} ${dim(elapsed, this.colorEnabled)}\n`);
      throw error;
    }
  }
}

export function logError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
