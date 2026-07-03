import * as fc from 'fast-check';
import { createLogger, redact } from '../logger';

describe('redact', () => {
  it('masks sensitive keys at any depth for any value', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (email, password) => {
        const input = {
          email,
          nested: { password, profile: { email } },
          list: [{ email }],
          safe: 'keep-me',
        };
        const out = JSON.stringify(redact(input));
        expect(out).not.toContain(`"email":${JSON.stringify(email)}`);
        expect(out).toContain('[REDACTED]');
        expect(out).toContain('keep-me');
      }),
    );
  });

  it('leaves non-sensitive primitives untouched', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
  });
});

describe('createLogger', () => {
  it('emits single-line JSON with level, message and correlationId', () => {
    const lines: string[] = [];
    const logger = createLogger(
      { correlationId: 'corr-1', component: 'AuditWriter' },
      { sink: (l) => lines.push(l), now: () => new Date('2026-01-01T00:00:00.000Z') },
    );

    logger.info('provisioned', { sub: 'user-1' });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('INFO');
    expect(parsed.message).toBe('provisioned');
    expect(parsed.correlationId).toBe('corr-1');
    expect(parsed.component).toBe('AuditWriter');
    expect(parsed.context).toEqual({ sub: 'user-1' });
  });

  it('redacts sensitive context fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ correlationId: 'c' }, { sink: (l) => lines.push(l) });
    logger.warn('login', { email: 'a@b.com', idToken: 'xyz' });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.context.email).toBe('[REDACTED]');
    expect(parsed.context.idToken).toBe('[REDACTED]');
  });
});
