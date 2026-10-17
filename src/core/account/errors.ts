/** Account errors with messages written for people, not for logs. */

import { RemoteError } from '../sync/remote';

export type AccountErrorCode =
  | 'email-in-use'
  | 'wrong-credentials'
  | 'invalid-email'
  | 'weak-password'
  | 'too-many-requests'
  | 'offline'
  | 'denied'
  | 'quota'
  | 'signed-out'
  | 'recent-login'
  | 'disabled'
  | 'not-configured'
  | 'wrong-recovery-key'
  | 'corrupt'
  | 'other';

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

const MESSAGES: Record<string, [AccountErrorCode, string]> = {
  'auth/email-already-in-use': ['email-in-use', 'An account with this email already exists. Try logging in instead.'],
  'auth/invalid-credential': ['wrong-credentials', 'Email or password is incorrect.'],
  'auth/wrong-password': ['wrong-credentials', 'Email or password is incorrect.'],
  'auth/user-not-found': ['wrong-credentials', 'Email or password is incorrect.'],
  'auth/invalid-login-credentials': ['wrong-credentials', 'Email or password is incorrect.'],
  'auth/invalid-email': ['invalid-email', 'That email address does not look right.'],
  'auth/missing-email': ['invalid-email', 'Please enter your email address.'],
  'auth/weak-password': ['weak-password', 'Please choose a longer password.'],
  'auth/password-does-not-meet-requirements': ['weak-password', 'Please choose a stronger password.'],
  'auth/too-many-requests': ['too-many-requests', 'Too many attempts. Wait a few minutes and try again.'],
  'auth/network-request-failed': ['offline', 'No connection. Check your internet and try again.'],
  'auth/requires-recent-login': ['recent-login', 'For your security, log in again before doing this.'],
  'auth/user-disabled': ['disabled', 'This account has been disabled.'],
  'auth/operation-not-allowed': ['not-configured', 'Email sign-in is not enabled for this app yet.'],
  'auth/configuration-not-found': ['not-configured', 'The cloud project is not set up yet.'],
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': ['not-configured', 'The cloud project is not set up correctly.'],
};

export function toAccountError(err: unknown): AccountError {
  if (err instanceof AccountError) return err;
  if (err instanceof RemoteError) {
    const code: AccountErrorCode = err.kind === 'other' ? 'other' : err.kind;
    return new AccountError(code, err.message);
  }
  const code = (err as { code?: string })?.code;
  if (code && MESSAGES[code]) {
    const [c, m] = MESSAGES[code];
    return new AccountError(c, m);
  }
  if (code === 'permission-denied') return new AccountError('denied', 'The cloud refused access.');
  if (code === 'unavailable') return new AccountError('offline', 'No connection. Check your internet and try again.');
  return new AccountError('other', err instanceof Error ? err.message : 'Something went wrong.');
}
