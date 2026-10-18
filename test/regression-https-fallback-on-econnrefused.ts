// Regression test for HTTPS fallback when a router refuses connections on
// port 80 outright:
//
// Most Deco firmware that requires HTTPS answers a plain-http request with a
// 307 redirect, which HttpClient.request() already upgrades baseURL from. A
// field report (2026-09-23, homey5q) showed a different case: the router
// didn't listen on port 80 at all, so every login attempt failed instantly
// with ECONNREFUSED — no response to redirect from, so the device could never
// recover on its own, forever ("Session expired, re-authenticating..." /
// "Re-authentication failed N time(s)" in a loop with no way out).
//
// This test asserts that a fetch() rejecting with a connection-refused error
// on http:// causes HttpClient to retry immediately over https:// within the
// same request, rather than throwing straight away — and that a genuine
// timeout (not a fast-failing refused connection) does NOT get this retry,
// since that would double the wait for a router that's actually offline.
//
// Run with: npx tsc -p test/tsconfig.json && node test/dist/test/regression-https-fallback-on-econnrefused.js

import { HttpClient, AppLogger } from '../lib/http';

const silentLogger: AppLogger = { log: () => {}, error: () => {} };

function fakeResponse(status: number, body: string): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: () => null,
      getSetCookie: () => [],
    },
    text: async () => body,
  };
}

async function main() {
  await assertFallsBackToHttpsOnConnectionRefused();
  await assertDoesNotRetryOnTimeout();
  console.log('PASS: a refused connection on http:// retries immediately over https:// instead of failing forever.');
}

async function assertFallsBackToHttpsOnConnectionRefused() {
  const client = new HttpClient('http://192.168.1.44/cgi-bin/luci/', 15000, silentLogger);
  const calls: string[] = [];

  (global as any).fetch = async (url: string) => {
    calls.push(url);
    if (url.startsWith('http://')) {
      throw Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 192.168.1.44:80'), { code: 'ECONNREFUSED' }),
      });
    }
    return fakeResponse(200, JSON.stringify({ error_code: 0 }));
  };

  const result = await client.request({
    method: 'POST',
    url: ';stok=/login',
    data: Buffer.from('{}'),
    headers: { 'Content-Type': 'application/json' },
    params: { form: 'keys' },
  });

  if (calls.length !== 2 || !calls[0].startsWith('http://') || !calls[1].startsWith('https://')) {
    throw new Error(`Expected one http:// attempt followed by one https:// attempt, got: ${JSON.stringify(calls)}`);
  }
  if (result.data.error_code !== 0) {
    throw new Error('Expected the https:// retry to succeed and return its parsed response.');
  }
  if (!client.baseURL.startsWith('https://')) {
    throw new Error('Expected baseURL to be upgraded to https:// for subsequent requests.');
  }
}

async function assertDoesNotRetryOnTimeout() {
  const client = new HttpClient('http://10.0.0.5/cgi-bin/luci/', 15000, silentLogger);
  const calls: string[] = [];

  (global as any).fetch = async (url: string) => {
    calls.push(url);
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };

  let threw = false;
  try {
    await client.request({
      method: 'POST',
      url: ';stok=/login',
      data: Buffer.from('{}'),
      headers: { 'Content-Type': 'application/json' },
      params: { form: 'keys' },
    });
  } catch (e) {
    threw = true;
  }

  if (!threw) {
    throw new Error('Expected a timeout to still throw rather than retry over https://.');
  }
  if (calls.length !== 1) {
    throw new Error(`Expected a timeout to make exactly one attempt (no https:// retry), got: ${JSON.stringify(calls)}`);
  }
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
