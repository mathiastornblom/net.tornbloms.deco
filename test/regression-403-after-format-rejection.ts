// Regression test for the "one combo short" bug:
//
// When earlier combos already showed the firmware can't parse our request
// (HTTP 500 Lua crash, or a clean HTTP 200 with error_code 1 "no such
// callback"), authenticate() used to treat a subsequent 403 as proof the
// whole login protocol is unrecognised and abort the round immediately —
// see the comment above this branch in lib/client.ts for the original XE75
// Pro report that motivated it.
//
// Four more field reports since (Deco X55 fw 1.8.0, four Deco BE65 Pro,
// another XE75 Pro) showed that 403 landing at combo 5 of the 6
// content-type/body-format/password-mode combinations buildLoginCombos()
// generates — one combo short of the never-tried
// contentType=json/bodyFormat=json/passwordMode=hashed combination, every
// single time. Aborting there means the one combo most likely to actually
// work for this firmware never gets a chance.
//
// This script reproduces the exact trace shape from those reports and
// asserts authenticate() tries the 6th combo instead of giving up after
// the 5th.
//
// Run with: npx tsc -p test/tsconfig.json && node test/dist/test/regression-403-after-format-rejection.js

import DecoAPIWraper, { LoginAttempt } from '../lib/client';

async function main() {
  const api = new (DecoAPIWraper as any)('127.0.0.1', { log: () => {}, error: () => {} }) as any;

  // Baseline matches the HttpClient defaults, same as the field reports.
  api.c.forceJsonContentType = true;
  api.c.forceJsonBody = false;

  api.pingHost = async () => true;

  let call = 0;
  api.attemptLogin = async function (
    _password: string,
    combo: { contentType: boolean; jsonBody: boolean; hashed: boolean },
    trace: LoginAttempt[],
  ) {
    call += 1;
    this.c.forceJsonContentType = combo.contentType;
    this.c.forceJsonBody = combo.jsonBody;
    const passwordMode = combo.hashed ? 'hashed' : 'raw';

    if (call === 1 || call === 2) {
      // json + form: firmware crashes its Lua dispatcher outright.
      trace.push({ seq: call, contentType: 'json', bodyFormat: 'form', passwordMode, httpStatus: 500, errorCode: null, msg: 'HTTP 500' });
      throw Object.assign(new Error('FORMAT: body format rejected (firmware crash)'), { isBodyFormatError: true });
    }
    if (call === 3 || call === 4) {
      // urlencoded + form: firmware parses the request but can't route it.
      trace.push({ seq: call, contentType: 'urlencoded', bodyFormat: 'form', passwordMode, httpStatus: 200, errorCode: 1, msg: 'no such callback' });
      throw new Error('FORMAT: login response missing stok (error_code=1, msg=no such callback)');
    }
    if (call === 5) {
      // json + json, raw password: the router answers 403 instead.
      assert(combo.hashed === false, `expected the 5th combo to have passwordMode=raw, got ${JSON.stringify(combo)}`);
      trace.push({ seq: call, contentType: 'json', bodyFormat: 'json', passwordMode, httpStatus: 403, errorCode: null, msg: 'HTTP 403' });
      throw Object.assign(new Error('RETRY: Router rejected login (403). Will retry automatically.'), { isBodyFormatError: false });
    }
    if (call === 6) {
      // The combo that used to never get tried — json + json, hashed password.
      assert(combo.contentType === true && combo.jsonBody === true && combo.hashed === true,
        `expected the 6th combo to be contentType=json bodyFormat=json passwordMode=hashed, got ${JSON.stringify(combo)}`);
      this.stok = 'fake-stok-value';
      return;
    }
    throw new Error(`unexpected call ${call}`);
  };

  const trace: LoginAttempt[] = [];
  const ok = await api.authenticate('irrelevant-password', trace);

  assert(ok === true, 'authenticate() should have succeeded once it reached the 6th (previously untried) combo');
  assert(call === 6, `expected exactly 6 attemptLogin calls (the 403 at combo 5 should not have aborted the round), got ${call}`);

  console.log('PASS: a 403 after firmware-level format rejections tries the remaining combo(s) instead of aborting early.');
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
