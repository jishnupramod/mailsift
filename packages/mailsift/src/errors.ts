export type ErrorCode =
  | 'AUTH_FAILED'
  | 'APP_PASSWORD_REQUIRED'
  | 'CONNECTION_FAILED'
  | 'TLS_FAILED'
  | 'TIMEOUT'
  | 'FOLDER_MISSING'
  | 'RATE_LIMITED'
  | 'TOKEN_EXPIRED'
  | 'PROTOCOL_ERROR';

const MESSAGES: Record<ErrorCode, string> = {
  AUTH_FAILED: 'The mail server rejected the sign-in.',
  APP_PASSWORD_REQUIRED: 'The mail server requires an app password instead of the normal password.',
  CONNECTION_FAILED: 'Could not connect to the mail server.',
  TLS_FAILED: 'The secure connection to the mail server could not be verified.',
  TIMEOUT: 'The mail server did not respond in time.',
  FOLDER_MISSING: 'The mail folder was not found.',
  RATE_LIMITED: 'The mail server is limiting requests; try again later.',
  TOKEN_EXPIRED: 'The sign-in token has expired.',
  PROTOCOL_ERROR: 'The mail server returned an unexpected response.',
};

/** Error with a fixed message per code. Never carries server text, credentials or a cause. */
export class MailsiftError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MailsiftError';
    this.code = code;
  }
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'TimeoutError',
  // imapflow: socket, connect, greeting and TLS-upgrade timeouts
  'ETIMEOUT',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  // imapflow: waiting for a mailbox lock took too long
  'LockTimeout',
])
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'ENETDOWN',
  // imapflow: the connection dropped or was closed before the command finished
  'NoConnection',
  'EConnectionClosed',
  'StateLogout',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
]);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  // Node raises EPROTO when the TLS handshake fails
  'EPROTO',
]);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Maps imapflow and network errors to a MailsiftError. Server text is only
 * inspected to choose a code; it is never copied into the result.
 */
export function toMailsiftError(e: unknown): MailsiftError {
  if (e instanceof MailsiftError) return e;
  const err = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  const code = str(err.code);
  const responseText = str(err.responseText).toLowerCase();
  const serverCode = str(err.serverResponseCode).toUpperCase();

  if (TIMEOUT_CODES.has(code) || err.name === 'TimeoutError') return new MailsiftError('TIMEOUT');
  if (TLS_CODES.has(code) || code.startsWith('ERR_SSL')) return new MailsiftError('TLS_FAILED');

  if (/application-specific password|app password|app-specific password/.test(responseText)) {
    return new MailsiftError('APP_PASSWORD_REQUIRED');
  }
  if (serverCode === 'EXPIRED' || /token.*expired|expired.*token/.test(responseText)) {
    return new MailsiftError('TOKEN_EXPIRED');
  }
  if (err.authenticationFailed === true || serverCode === 'AUTHENTICATIONFAILED') {
    return new MailsiftError('AUTH_FAILED');
  }
  if (serverCode === 'NONEXISTENT' || err.mailboxMissing === true) {
    return new MailsiftError('FOLDER_MISSING');
  }
  if (
    code === 'ETHROTTLE' ||
    serverCode === 'LIMIT' ||
    serverCode === 'THROTTLED' ||
    /too many (simultaneous )?connections|rate limit|throttl/.test(responseText)
  ) {
    return new MailsiftError('RATE_LIMITED');
  }
  if (NETWORK_CODES.has(code)) return new MailsiftError('CONNECTION_FAILED');
  return new MailsiftError('PROTOCOL_ERROR');
}
