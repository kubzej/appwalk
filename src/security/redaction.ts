export const REDACTED_VALUE = '[REDACTED]';

export interface RedactOptions {
  /** Keep tool inputs usable for later deterministic replay where possible. */
  preserveToolInputs?: boolean;
  /** Keep path metadata needed to locate a user-supplied artifact, while still redacting its value if it matches a known secret. */
  preservePathFields?: boolean;
  /** Remove every query parameter from diagnostic URLs instead of only sensitive ones. */
  stripUrlQuery?: boolean;
}

const DEFAULT_OPTIONS: Required<RedactOptions> = {
  preserveToolInputs: false,
  preservePathFields: false,
  stripUrlQuery: false,
};

const SENSITIVE_KEY =
  /(?:^|[-_])(api[-_]?key|authorization|cookie|set[-_]?cookie|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|storage(?:state)?|credential|client[-_]?secret|private[-_]?key|session(?:[-_]?id)?)(?:$|[-_])/i;
const SENSITIVE_QUERY =
  /(api[-_]?key|authorization|cookie|password|passwd|secret|token|access_token|refresh_token|session|credential)/i;
const SENSITIVE_TEXT = /(Bearer\s+)[^\s]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i;
const SENSITIVE_TEXT_REPLACE = /(Bearer\s+)[^\s]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi;
const KEY_VALUE_SECRET =
  /\b(password|passwd|api[_-]?key|authorization|token|secret|client[_-]?secret)\s*[:=]\s*([^,\s}]+)/i;
const KEY_VALUE_SECRET_REPLACE =
  /\b(password|passwd|api[_-]?key|authorization|token|secret|client[_-]?secret)\s*[:=]\s*([^,\s}]+)/gi;
const ABSOLUTE_URL = /https?:\/\/[^\s"'<>]+/gi;
const RELATIVE_URL_WITH_QUERY = /(^|[\s(])((?:\/|\?)[^\s"'<>]*\?[^\s"'<>]+)/g;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ENCODED_ANSI_ESCAPE = /%1b\[[0-?]*[ -/]*[@-~]/gi;
const SENSITIVE_LOCATOR =
  /password|passwd|secret|token|authorization|api[-_ ]?key|card(?:[-_ ]?number)?|cvv|cvc|ssn|social[-_ ]?security/i;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return (
    SENSITIVE_KEY.test(key) ||
    /(?:token|secret|password|credential|authorization|cookie|apikey|privatekey|storage(state)?|sessionid)$/.test(
      normalizeKey(key),
    )
  );
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function replaceLiteral(value: string, secret: string): string {
  return value.split(secret).join(REDACTED_VALUE);
}

function redactUrlValue(value: string, options: RedactOptions): string {
  const absolute = isAbsoluteUrl(value);
  if (!absolute && !/^(?:\/|\?)/.test(value)) return value;
  try {
    const parsed = new URL(value, 'https://redactor.invalid');
    if (options.stripUrlQuery) {
      parsed.search = '';
    } else {
      for (const name of [...parsed.searchParams.keys()]) {
        if (SENSITIVE_QUERY.test(name)) parsed.searchParams.set(name, REDACTED_VALUE);
      }
    }
    if (parsed.hash && /(token|secret|auth|session|state)/i.test(parsed.hash)) parsed.hash = REDACTED_VALUE;
    return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return value;
  }
}

function redactString(value: string, secrets: readonly string[], options: RedactOptions): string {
  let result = value;
  for (const secret of secrets) result = replaceLiteral(result, secret);

  result = result.replace(SENSITIVE_TEXT_REPLACE, (_match, prefix: string | undefined) =>
    prefix ? `${prefix}${REDACTED_VALUE}` : REDACTED_VALUE,
  );
  result = result.replace(KEY_VALUE_SECRET_REPLACE, (_match, key: string) => `${key}=${REDACTED_VALUE}`);
  result = result.replace(ABSOLUTE_URL, (url) => redactUrlValue(url, options));
  result = result.replace(
    RELATIVE_URL_WITH_QUERY,
    (_match, prefix: string, url: string) => `${prefix}${redactUrlValue(url, options)}`,
  );
  return redactUrlValue(result, options).replace(ANSI_ESCAPE, '').replace(ENCODED_ANSI_ESCAPE, '');
}

function isToolInputSensitive(input: Record<string, unknown>): boolean {
  return typeof input.locator === 'string' && SENSITIVE_LOCATOR.test(input.locator);
}

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: readonly (string | undefined)[] = []) {
    this.secrets = [
      ...new Set(secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length >= 3)),
    ].sort((left, right) => right.length - left.length);
  }

  text(value: string, options: RedactOptions = {}): string {
    return this.redact(value, options) as string;
  }

  url(value: string, options: RedactOptions = {}): string {
    return redactUrlValue(redactString(value, this.secrets, options), options);
  }

  diagnosticUrl(value: string): string {
    return this.url(value, { stripUrlQuery: true });
  }

  hasSensitiveData(value: unknown): boolean {
    if (Array.isArray(value)) return value.some((item) => this.hasSensitiveData(item));
    if (typeof value === 'string') {
      return (
        this.secrets.some((secret) => value.includes(secret)) ||
        SENSITIVE_TEXT.test(value) ||
        KEY_VALUE_SECRET.test(value)
      );
    }
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, entry]) => isSensitiveKey(key) || this.hasSensitiveData(entry));
  }

  redact(value: unknown, options: RedactOptions = {}, key?: string, parentKey?: string): unknown {
    const resolved = { ...DEFAULT_OPTIONS, ...options };
    if (typeof value === 'string') return redactString(value, this.secrets, resolved);
    if (Array.isArray(value)) return value.map((item) => this.redact(item, resolved, undefined, key));
    if (!value || typeof value !== 'object') return value;

    const object = value as Record<string, unknown>;
    const inputSensitive = key === 'input' && isToolInputSensitive(object);
    return Object.fromEntries(
      Object.entries(object).map(([entryKey, entryValue]) => {
        const isToolInput = key === 'input' || parentKey === 'input';
        const isToolValue = isToolInput && entryKey === 'value';
        const isToolFilePath = isToolInput && entryKey === 'filePaths';
        const isPathField = /path(?:s)?$/i.test(entryKey);
        if (isSensitiveKey(entryKey)) {
          if (resolved.preservePathFields && isPathField) {
            // Keep the path field available to the consumer; its nested/string value still goes
            // through the normal exact-secret and URL redaction rules below.
          } else if (resolved.preserveToolInputs && (isToolValue || isToolFilePath)) {
            if (isToolValue && inputSensitive) return [entryKey, REDACTED_VALUE];
          } else {
            return [entryKey, REDACTED_VALUE];
          }
        }
        if (isToolValue && !resolved.preserveToolInputs) return [entryKey, REDACTED_VALUE];
        if (isToolValue && inputSensitive) return [entryKey, REDACTED_VALUE];
        if (isToolFilePath && !resolved.preserveToolInputs) return [entryKey, REDACTED_VALUE];
        return [entryKey, this.redact(entryValue, resolved, entryKey, key)];
      }),
    );
  }
}

export const defaultRedactor = new Redactor();

/** Compatibility helper for callers that only need the default log/artifact policy. */
export function redact(value: unknown, key?: string, parentKey?: string): unknown {
  return defaultRedactor.redact(value, {}, key, parentKey);
}
