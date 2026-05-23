import { ConsoleLogger, Injectable, LoggerService } from '@nestjs/common';

// D16: request-side body redaction. `password`, `passwordHash`, and
// `Authorization` are stripped before any log line is written. Anything that
// passes a request body to logger.log / logger.debug / logger.error must route
// through redact() first.
// All entries must be lowercase — the lookup uses k.toLowerCase().
const REDACTED_KEYS = new Set(['password', 'passwordhash', 'authorization']);

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
  }
  return out;
}

@Injectable()
export class RedactingLogger extends ConsoleLogger implements LoggerService {
  log(message: unknown, ...optional: unknown[]): void {
    super.log(redact(message) as string, ...optional.map(redact));
  }

  warn(message: unknown, ...optional: unknown[]): void {
    super.warn(redact(message) as string, ...optional.map(redact));
  }

  error(message: unknown, ...optional: unknown[]): void {
    super.error(redact(message) as string, ...optional.map(redact));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    super.debug(redact(message) as string, ...optional.map(redact));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    super.verbose(redact(message) as string, ...optional.map(redact));
  }
}
