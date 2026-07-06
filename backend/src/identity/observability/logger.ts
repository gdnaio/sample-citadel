/**
 * Structured, correlation-aware logging for the identity shared kernel (Standard
 * observability, D3-9). Emits single-line JSON with a `correlationId` and redacts
 * sensitive fields (email, tokens, secrets) so PII does not leak into logs.
 */

const SENSITIVE_KEYS = new Set([
  'email',
  'password',
  'secret',
  'token',
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'authorization',
]);

const REDACTED = '[REDACTED]';

/** Recursively redact sensitive keys from an arbitrary value. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(val);
    }
    return out;
  }
  return value;
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface LoggerBase {
  correlationId: string;
  component?: string;
}

export interface LoggerOptions {
  /** Sink for emitted lines (defaults to console.log). Injectable for tests. */
  sink?: (line: string) => void;
  /** Injectable clock for deterministic timestamps (testing). */
  now?: () => Date;
}

export function createLogger(base: LoggerBase, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? ((line: string): void => console.log(line));
  const now = options.now ?? ((): Date => new Date());

  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    sink(
      JSON.stringify({
        level,
        message,
        correlationId: base.correlationId,
        component: base.component,
        timestamp: now().toISOString(),
        ...(context ? { context: redact(context) } : {}),
      }),
    );
  };

  return {
    info: (message, context): void => emit('INFO', message, context),
    warn: (message, context): void => emit('WARN', message, context),
    error: (message, context): void => emit('ERROR', message, context),
  };
}
