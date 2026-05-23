import { redact } from './redacting.logger';

// D16: redact() is the chokepoint that strips sensitive keys before any log
// line is written. The custom RedactingLogger isn't wired in NODE_ENV=test
// (NestJS uses the default console logger), so the pure function is unit-
// tested here.
describe('redact (D16)', () => {
  it('returns primitives as-is', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('redacts top-level password', () => {
    expect(redact({ username: 'alice', password: 's3cret' })).toEqual({
      username: 'alice',
      password: '[REDACTED]',
    });
  });

  it('redacts top-level passwordHash', () => {
    expect(redact({ id: 1, passwordHash: '$2b$10$abc' })).toEqual({
      id: 1,
      passwordHash: '[REDACTED]',
    });
  });

  it('redacts authorization (case-insensitive)', () => {
    expect(redact({ Authorization: 'Bearer eyJ...' })).toEqual({
      Authorization: '[REDACTED]',
    });
    expect(redact({ authorization: 'Bearer eyJ...' })).toEqual({
      authorization: '[REDACTED]',
    });
    expect(redact({ AUTHORIZATION: 'Bearer eyJ...' })).toEqual({
      AUTHORIZATION: '[REDACTED]',
    });
  });

  it('redacts nested password inside a body wrapper', () => {
    expect(redact({ body: { username: 'bob', password: 'hunter2' } })).toEqual({
      body: { username: 'bob', password: '[REDACTED]' },
    });
  });

  it('redacts password inside array elements', () => {
    expect(
      redact([
        { username: 'alice', password: 'a' },
        { username: 'bob', password: 'b' },
      ]),
    ).toEqual([
      { username: 'alice', password: '[REDACTED]' },
      { username: 'bob', password: '[REDACTED]' },
    ]);
  });

  it('does not mutate the input', () => {
    const input = { username: 'alice', password: 's3cret' };
    const out = redact(input) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED]');
    expect(input.password).toBe('s3cret');
  });

  it('does not match unrelated keys that contain "password" as a substring', () => {
    expect(redact({ passwordResetToken: 'tok' })).toEqual({
      passwordResetToken: 'tok',
    });
    expect(redact({ oldPassword: 'a' })).toEqual({ oldPassword: 'a' });
  });

  it('handles deeply nested mixed structures', () => {
    expect(
      redact({
        request: {
          headers: { Authorization: 'Bearer x' },
          body: {
            user: { name: 'a', password: 'p1' },
            tokens: [{ password: 'p2' }, 'plain-string'],
          },
        },
      }),
    ).toEqual({
      request: {
        headers: { Authorization: '[REDACTED]' },
        body: {
          user: { name: 'a', password: '[REDACTED]' },
          tokens: [{ password: '[REDACTED]' }, 'plain-string'],
        },
      },
    });
  });
});
