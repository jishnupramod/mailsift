import { describe, expect, it } from 'vitest';
import { MailsiftError, toMailsiftError } from '../src/index.js';

describe('toMailsiftError', () => {
  it('maps authenticationFailed to AUTH_FAILED', () => {
    expect(toMailsiftError({ authenticationFailed: true, responseText: 'Invalid credentials' }).code).toBe('AUTH_FAILED');
  });

  it('maps a Gmail application-specific password response', () => {
    const e = { authenticationFailed: true, responseText: 'Application-specific password required' };
    expect(toMailsiftError(e).code).toBe('APP_PASSWORD_REQUIRED');
  });

  it('maps ETIMEDOUT to TIMEOUT', () => {
    expect(toMailsiftError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).code).toBe('TIMEOUT');
  });

  it('maps certificate errors to TLS_FAILED', () => {
    expect(toMailsiftError(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' })).code).toBe('TLS_FAILED');
    expect(toMailsiftError(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).code).toBe('TLS_FAILED');
  });

  it('maps missing folders, throttling and expired tokens', () => {
    expect(toMailsiftError({ serverResponseCode: 'NONEXISTENT' }).code).toBe('FOLDER_MISSING');
    expect(toMailsiftError({ responseText: 'Too many simultaneous connections' }).code).toBe('RATE_LIMITED');
    expect(toMailsiftError({ responseText: 'Access token has expired' }).code).toBe('TOKEN_EXPIRED');
  });

  it('falls back to CONNECTION_FAILED', () => {
    expect(toMailsiftError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code).toBe('CONNECTION_FAILED');
    expect(toMailsiftError('weird').code).toBe('CONNECTION_FAILED');
    expect(toMailsiftError(null).code).toBe('CONNECTION_FAILED');
  });

  it('never leaks a password, server text or the original error', () => {
    const secret = 'hunter2-s3cret';
    const original = Object.assign(new Error(`LOGIN user ${secret} failed`), {
      authenticationFailed: true,
      responseText: `bad password ${secret}`,
      command: `LOGIN user ${secret}`,
    });
    const out = toMailsiftError(original);
    expect(out).toBeInstanceOf(MailsiftError);
    expect(out.message).not.toContain(secret);
    expect(out.cause).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.stack ?? '').not.toContain(secret);
  });

  it('returns an existing MailsiftError unchanged', () => {
    const e = new MailsiftError('TIMEOUT');
    expect(toMailsiftError(e)).toBe(e);
  });
});
