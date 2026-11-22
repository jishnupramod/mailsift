import { describe, expect, it } from 'vitest';
import { MailsiftError, toMailsiftError } from '../src/errors.js';

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

  it.each(['ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ESOCKETTIMEDOUT'])(
    'maps %s to TIMEOUT',
    (code) => {
      expect(toMailsiftError(Object.assign(new Error('x'), { code })).code).toBe('TIMEOUT');
    },
  );

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'])(
    'maps %s to CONNECTION_FAILED',
    (code) => {
      expect(toMailsiftError(Object.assign(new Error('x'), { code })).code).toBe('CONNECTION_FAILED');
    },
  );

  it.each(['NoConnection', 'EConnectionClosed', 'StateLogout', 'ClosedAfterConnectText', 'ClosedAfterConnectTLS', 'ECONNABORTED', 'ENETDOWN'])(
    'maps a dropped or closed connection (%s) to CONNECTION_FAILED',
    (code) => {
      expect(toMailsiftError(Object.assign(new Error('Connection not available'), { code })).code).toBe('CONNECTION_FAILED');
    },
  );

  it("maps imapflow's ETHROTTLE to RATE_LIMITED", () => {
    expect(toMailsiftError(Object.assign(new Error('x'), { code: 'ETHROTTLE' })).code).toBe('RATE_LIMITED');
  });

  it("maps imapflow's LockTimeout to TIMEOUT", () => {
    expect(toMailsiftError(Object.assign(new Error('x'), { code: 'LockTimeout' })).code).toBe('TIMEOUT');
  });

  it('keeps EPROTO, which Node raises for failed TLS handshakes, as TLS_FAILED', () => {
    expect(toMailsiftError(Object.assign(new Error('x'), { code: 'EPROTO' })).code).toBe('TLS_FAILED');
  });

  it('reports unrecognised errors as PROTOCOL_ERROR', () => {
    expect(toMailsiftError(new TypeError('x is not a function')).code).toBe('PROTOCOL_ERROR');
    expect(toMailsiftError({ responseStatus: 'BAD', responseText: 'whatever' }).code).toBe('PROTOCOL_ERROR');
    expect(toMailsiftError('weird').code).toBe('PROTOCOL_ERROR');
    expect(toMailsiftError(null).code).toBe('PROTOCOL_ERROR');
    expect(toMailsiftError(new TypeError('x')).message).toBe('The mail server returned an unexpected response.');
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
