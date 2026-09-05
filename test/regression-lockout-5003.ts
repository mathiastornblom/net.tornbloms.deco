// Regression test for the account-lockout misdiagnosis:
//
// When a Deco has locked the account after too many failed logins it answers
// the login POST with:
//
//   {"result":{"failureCount":10,"attemptsAllowed":0},"error_code":-5003}
//
// Before v1.4.70 nothing recognised -5003. The response had no `stok`, so
// attemptLogin() fell through to the generic "FORMAT: login response missing
// stok" branch, authenticate() treated that as "wrong combo" and moved on to
// the next one, and each of those spent another login attempt against an
// already-locked account. Once the router started answering 403 instead, that
// was reported as "RETRY: session limit" and driver.ts retried the whole thing
// on a backoff schedule — so the app kept refreshing the very lockout it was
// waiting out, and told the user to close other Deco sessions or create a
// Manager account, neither of which could help. A field log (2026-08-09)
// showed this loop running for minutes on end.
//
// This test asserts the two properties the fix must have:
//   1. -5003 aborts authenticate() immediately with a LOCKED: error.
//   2. No further combo is attempted after it.
//
// Run with: npx tsc -p test/tsconfig.json && node test/dist/test/regression-lockout-5003.js

import crypto from 'crypto';
import DecoAPIWraper from '../lib/client';

// A throwaway RSA public key, so the real attemptLogin() can actually encrypt
// the password and reach the point where it classifies the router's response —
// which is the part under test. Only the response classification is faked.
const { publicKey: fakeRouterKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });

async function main() {
  await assertLockoutStopsEverything();
  await assertLockoutIsNotConfusedWithWrongPassword();
  console.log('PASS: error_code -5003 aborts login immediately instead of burning further attempts.');
}

/**
 * Drives the real attemptLogin() against a fake transport that returns the
 * exact -5003 payload from the field log, and checks that authenticate()
 * gives up after a single login POST.
 */
async function assertLockoutStopsEverything() {
  const api = new (DecoAPIWraper as any)('127.0.0.1', { log: () => {}, error: () => {} }) as any;

  let loginPosts = 0;

  // Stub only the transport that attemptLogin() drives, leaving the real
  // encryption and the real response classification in place.
  api.ensureDecoInstance = function () {
    this.decoInstance = {
      getPasswordKey: async () => fakeRouterKey,
      getSessionKey: async () => ({ key: fakeRouterKey, seq: 1 }),
      doEncryptedPost: async () => {
        loginPosts += 1;
        return { error_code: -5003, result: { failureCount: 10, attemptsAllowed: 0 } };
      },
    };
  };

  let error: any = null;
  try {
    await api.authenticate('irrelevant-password');
  } catch (e: any) {
    error = e;
  }

  assert(error !== null, 'authenticate() should have thrown on a -5003 lockout response');
  assert(
    String(error.message).startsWith('LOCKED:'),
    `expected a LOCKED: error so driver.ts stops retrying, got: ${error.message}`,
  );
  assert(
    loginPosts === 1,
    `expected exactly one login POST before giving up, got ${loginPosts} — the lockout is being refreshed by our own retries`,
  );
  assert(
    Array.isArray(error.loginTrace) && error.loginTrace.length === 1,
    'the lockout error should still carry the login trace for the diagnostic view',
  );
}

/**
 * -5002 (wrong password) and -5003 (locked out) need different messages: one
 * asks the user to check the password, the other has to tell them to stop
 * trying for a while. Guard against a future simplification that folds them
 * back together.
 */
async function assertLockoutIsNotConfusedWithWrongPassword() {
  const api = new (DecoAPIWraper as any)('127.0.0.1', { log: () => {}, error: () => {} }) as any;

  api.ensureDecoInstance = function () {
    this.decoInstance = {
      getPasswordKey: async () => fakeRouterKey,
      getSessionKey: async () => ({ key: fakeRouterKey, seq: 1 }),
      doEncryptedPost: async () => ({ error_code: -5002, result: { attemptsAllowed: 3 } }),
    };
  };

  let error: any = null;
  try {
    await api.authenticate('irrelevant-password');
  } catch (e: any) {
    error = e;
  }

  assert(error !== null, 'authenticate() should have thrown on a -5002 response');
  assert(
    String(error.message).startsWith('CREDENTIALS:'),
    `-5002 must stay a CREDENTIALS: error, got: ${error.message}`,
  );
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
