import crypto, { KeyObject } from 'crypto';
import dns from 'dns/promises';
import Deco from './deco';
import { encryptRsa } from '././utils/rsa';
import { AESKey, generateAESKey } from '././utils/aes';
import { HttpClient, AppLogger } from './http';


export type { AppLogger };

// Define a constant for the username to be used for authentication
const userName = 'admin';

export interface ErrorResponse {
  errorcode: string;
  success: boolean;
}

export interface LoginAttempt {
  seq: number;
  contentType: 'urlencoded' | 'json';
  bodyFormat: 'form' | 'json';
  passwordMode: 'raw' | 'hashed';
  httpStatus: number | null;
  errorCode: number | null;
  msg: string | null;
}
// Interface to define the structure of the response for client list
export interface ClientListResponse {
  error_code: number;
  result: {
    client_list: Array<{
      access_host: string;
      client_mesh: boolean;
      client_type: string;
      connection_type: string;
      down_speed: number;
      enable_priority: boolean;
      interface: string;
      ip: string;
      mac: string;
      name: string;
      online: boolean;
      owner_id: string;
      remain_time: number;
      space_id: string;
      up_speed: number;
      wire_type: string;
    }>;
  };
}

export interface WLANNetworkResponse {
  error_code: number;
  result: {
    band5_1: {
      backhaul: {
        channel: number;
      };
      guest: {
        password: string;
        ssid: string;
        vlan_id: number;
        enable: boolean;
        need_set_vlan: boolean;
      };
      host: {
        password: string;
        ssid: string;
        channel: number;
        enable: boolean;
        mode: string;
        channel_width: string;
        enable_hide_ssid: boolean;
      };
    };
    is_eg: boolean;
    band2_4: {
      backhaul: {
        channel: number;
      };
      guest: {
        password: string;
        ssid: string;
        vlan_id: number;
        enable: boolean;
        need_set_vlan: boolean;
      };
      host: {
        password: string;
        ssid: string;
        channel: number;
        enable: boolean;
        mode: string;
        channel_width: string;
        enable_hide_ssid: boolean;
      };
    };
  };
}

export interface Band {
  backhaul: {
    channel: number;
  };
  guest: {
    password: string;
    ssid: string;
    vlan_id: number;
    enable: boolean;
    need_set_vlan: boolean;
  };
  host: {
    password: string;
    ssid: string;
    channel: number;
    enable: boolean;
    mode: string;
    channel_width: string;
    enable_hide_ssid: boolean;
  };
}

// Interface to define the structure of the response for WAN
export interface WANResponse {
  error_code: number;
  result: {
    wan: {
      ip_info: {
        mac: string;
        dns1: string;
        dns2: string;
        mask: string;
        gateway: string;
        ip: string;
      };
      dial_type: string;
      info: string;
      enable_auto_dns: boolean;
    };
    lan: {
      ip_info: {
        mac: string;
        mask: string;
        ip: string;
      };
    };
  };
}

// Interface to define the structure of the response for device list
export interface DeviceListResponse {
  error_code: number;
  result: {
    device_list: Array<{
      device_ip: string;
      device_id?: string;
      device_type: string;
      nand_flash: boolean;
      owner_transfer?: boolean;
      previous: string;
      bssid_5g: string;
      bssid_2g: string;
      bssid_sta_5g: string;
      bssid_sta_2g: string;
      parent_device_id?: string;
      software_ver: string;
      role: string;
      product_level: number;
      hardware_ver: string;
      inet_status: string;
      support_plc: boolean;
      mac: string;
      set_gateway_support: boolean;
      inet_error_msg: string;
      connection_type?: string[];
      custom_nickname?: string;
      nickname: string;
      group_status: string;
      oem_id: string;
      signal_level: {
        band2_4: string;
        band5: string;
      };
      device_model: string;
      oversized_firmware: boolean;
      speed_get_support?: boolean;
      hw_id: string;
      imei?: string; // present on cellular models (X50-5G, X50-4G, etc.)
    }>;
  };
}

export interface InternetResponse {
  error_code: number;
  result: {
    ipv6: {
      connect_type: string;
      auto_detect_type: string;
      error_code: number;
      inet_status: string;
      dial_status: string;
    };
    ipv4: {
      connect_type: string;
      auto_detect_type: string;
      error_code: number;
      dial_status: string;
      inet_status: string;
    };
    link_status: string;
  };
}

// Interface to define the structure of the response for advanced data
export interface AdvancedResponse {
  error_code: number;
  result: {
    support_dfs: boolean;
  };
}

// Interface to define the structure of the response for performance data
export interface PerformanceResponse {
  error_code: number;
  result: {
    cpu_usage: number;
    mem_usage: number;
  };
}

// LTE interface config — data usage for the current billing period.
// Available on Deco models with cellular connectivity (e.g. X50-4G, X50-5G).
// Returned by /admin/network?form=lte_intf_cfg
export interface LteIntfCfgResponse {
  error_code: number;
  result: {
    // Current-period RX bytes (unit varies by firmware — log raw to verify)
    curStatistics?: string | number;
    // Current-period TX bytes
    totalStatistics?: string | number;
    dataLimit?: string | number;
    enableDataLimit?: string | number;
    curRxSpeed?: string | number;
    curTxSpeed?: string | number;
  };
}

// LTE link config — SIM and network-type status.
// Returned by /admin/network?form=lte_link_cfg
export interface LteLinkCfgResponse {
  error_code: number;
  result: {
    connectStatus?: string;
    networkType?: string;
    simStatus?: string;
    roamingStatus?: string;
  };
}

// Interface for the structure of login request
interface LoginRequest {
  params: {
    password: string;
  };
  operation: string;
}

// Interface for generic request parameters
interface RequestParams {
  operation?: string;
  params?: { [key: string]: any };
}

// Class to handle endpoint arguments and query parameters
class EndpointArgs {
  form: string;

  constructor(form: string) {
    this.form = form;
  }

  // Method to create URL search parameters
  queryParams(): URLSearchParams {
    const q = new URLSearchParams();
    q.append('form', this.form);
    return q;
  }
}

// Per-request HTTP timeout. This was a flat 10s, and two users reported the
// resulting "Timeout after 10000ms" dialog — which is ours, not Homey's ~30s
// pairing RPC timeout. Measured request times from diagnostic logs show why 10s
// was too tight: device_list took 8.1s on a five-node mesh, and 4.2s on a
// three-node one where the login POST alone took 2.8s.
// A margin under two seconds on the largest mesh we have measured is not a
// margin. 15s keeps roughly double the worst measured time while still leaving
// room inside authenticate()'s own 25s budget for more than one request.
const HTTP_TIMEOUT_MS = 15000;

const consoleLogger: AppLogger = { log: console.log, error: console.error };

// Main Client class to interact with the API
export default class DecoAPIWraper {
  public c: HttpClient;
  public aes: AESKey | undefined;
  public rsa: KeyObject | null = null;
  public hash: string = '';
  public stok: string = '';
  public sequence: number = 0;
  public host: string;
  public decoInstance: Deco | undefined;
  private logger: AppLogger;

  // Constructor to initialize the client with the target host
  constructor(target: string, logger: AppLogger = consoleLogger) {
    const normalizedTarget = target.trim().replace(/^https?:\/\//i, '').split('/')[0];
    const baseUrl = `http://${normalizedTarget}/cgi-bin/luci/`;
    this.host = normalizedTarget;
    this.logger = logger;
    this.c = new HttpClient(baseUrl, HTTP_TIMEOUT_MS, logger);
  }

  // pingHost() used to live here. It was removed in v1.4.70 — see the comment
  // in authenticate() for why a pre-flight reachability probe cost ~10s per
  // re-auth without ever changing what happened next.

  // Private method to ensure the Deco instance is initialized or updated
  private ensureDecoInstance() {
    if (!this.decoInstance) {
      this.decoInstance = new Deco(
        this.aes!,
        this.hash,
        this.rsa!,
        this.sequence,
        this.c,
        this.logger,
      );
    } else {
      this.decoInstance.updateContext(
        this.aes!,
        this.hash,
        this.rsa!,
        this.sequence,
      );
    }
  }

  // Public method to authenticate the client with the given password.
  // Returns true on success.
  // Throws AuthNetworkError when the router cannot be reached.
  // Throws AuthCredentialsError when the password is wrong.
  // Throws Error for other failures.
  //
  // _retried: true after a Content-Type flip (prevents a second flip).
  // _skipRehash: true when retrying with a pre-hashed password (prevents double-hashing).
  //   Some firmware expects RSA(MD5(admin+password)) instead of RSA(raw_password).
  //   When _skipRehash=true, `password` is already MD5(admin+rawPassword) and
  //   this.hash must NOT be recomputed so the sign stays consistent.
  // _jsonBody: true after switching to JSON body format {"sign":"...","data":"..."}.
  //   Newer Deco firmware (e.g. X50 fw 1.8.0) crashes with HTTP 500 when it receives
  //   form-encoded body "sign=...&data=..." with Content-Type: application/json.
  // _trace: accumulates one LoginAttempt per login POST across all recursive retries.
  //   Attached to thrown errors so callers can surface diagnostic info.
  /**
   * Builds the ordered list of (contentType, bodyFormat, passwordMode) combinations
   * to try during login. Different Deco models/firmware genuinely need different
   * combinations and there is no single safe default to guess — telemetry across
   * users shows roughly even use of JSON and form-urlencoded content types, and
   * the previous design (guess one default, conditionally retry only on specific
   * error signatures like "no such callback") repeatedly misclassified failures
   * on firmware whose error didn't match the expected signature, regressing
   * pairing for models that worked on earlier versions (e.g. X50-4G, v1.4.50-59).
   * `authenticate()` now tries every combination in this list and treats ANY
   * failure as "try the next one" rather than trying to interpret the error —
   * the only exceptions are NETWORK/RETRY errors, which are not format issues
   * and bail out immediately (see authenticate() below).
   * jsonBody is only meaningful paired with contentType=json (the firmware
   * parses the body according to Content-Type), so urlencoded+jsonBody is
   * never tried. `current` is a snapshot of the cached/known-good combo
   * (`this.c.forceJsonContentType`/`forceJsonBody`, restored per-device from
   * the device store) taken by the caller *before* any combo attempt has
   * mutated those fields — see authenticate(), which must not read them
   * directly here since attemptLogin() overwrites them on every attempt,
   * including failed ones.
   */
  private buildLoginCombos(current: {
    contentType: boolean;
    jsonBody: boolean;
  }): Array<{ contentType: boolean; jsonBody: boolean; hashed: boolean }> {
    const all = [
      { contentType: false, jsonBody: false },
      { contentType: true, jsonBody: false },
      { contentType: true, jsonBody: true },
    ];
    const ordered = [
      current,
      ...all.filter((c) => c.contentType !== current.contentType || c.jsonBody !== current.jsonBody),
    ];
    const combos: Array<{ contentType: boolean; jsonBody: boolean; hashed: boolean }> = [];
    for (const c of ordered) {
      combos.push({ ...c, hashed: false });
      combos.push({ ...c, hashed: true });
    }
    return combos;
  }

  /**
   * Performs one full login attempt (password key → session key → encrypted
   * login POST) using a specific contentType/bodyFormat/passwordMode combo.
   * On success, sets this.stok and returns. On failure, throws — NETWORK:/
   * RETRY:-prefixed errors signal the caller to stop trying other combos
   * (see authenticate()); anything else means "try the next combo".
   */
  private async attemptLogin(
    password: string,
    combo: { contentType: boolean; jsonBody: boolean; hashed: boolean },
    trace: LoginAttempt[],
  ): Promise<void> {
    this.c.forceJsonContentType = combo.contentType;
    this.c.forceJsonBody = combo.jsonBody;
    const effectivePassword = combo.hashed ? this.hash : password;

    // Generate a fresh AES key per attempt — the router's session/password keys
    // are tied to this exchange and firmware may reject a reused key on retry.
    this.aes = generateAESKey();
    this.ensureDecoInstance();

    this.logger.log('client.ts: attemptLogin: retrieving password key');
    let passwordKey;
    try {
      passwordKey = await this.decoInstance!.getPasswordKey();
    } catch (e: any) {
      this.logger.error('client.ts: attemptLogin: network error fetching password key:', e);
      // Attach the trace here too. Every NETWORK: error in the diagnostic logs
      // we have arrived with `loginTrace: []`, because these throws predate the
      // caller's attach step — so the one field meant to tell us what had
      // already been tried was empty in exactly the reports that needed it.
      throw Object.assign(new Error(`NETWORK: Cannot reach router at ${this.host}. Check the IP and that Homey is on the same network.`), { cause: e, loginTrace: trace });
    }
    if (!passwordKey) {
      this.logger.error('client.ts: attemptLogin: failed to retrieve password key — check device IP and that the Deco web interface is reachable');
      throw Object.assign(new Error(`NETWORK: Cannot reach router at ${this.host}. Check the IP and that Homey is on the same network.`), { loginTrace: trace });
    }

    const encryptedPassword = encryptRsa(effectivePassword, passwordKey);
    if (!encryptedPassword) {
      throw new Error('RSA encryption of password failed.');
    }

    this.logger.log('client.ts: attemptLogin: retrieving session key');
    let sessionKey, sequence;
    try {
      ({ key: sessionKey, seq: sequence } = await this.decoInstance!.getSessionKey());
    } catch (e: any) {
      this.logger.error('client.ts: attemptLogin: network error fetching session key:', e);
      throw Object.assign(new Error(`NETWORK: Cannot reach router at ${this.host}. Check the IP and that Homey is on the same network.`), { cause: e, loginTrace: trace });
    }
    if (!sessionKey) {
      throw Object.assign(new Error(`NETWORK: Cannot reach router at ${this.host}. Check the IP and that Homey is on the same network.`), { loginTrace: trace });
    }

    this.rsa = sessionKey;
    this.sequence = sequence;

    const loginReq: LoginRequest = { params: { password: encryptedPassword }, operation: 'login' };
    const args = new EndpointArgs('login');

    const attempt: LoginAttempt = {
      seq: trace.length + 1,
      contentType: combo.contentType ? 'json' : 'urlencoded',
      bodyFormat: combo.jsonBody ? 'json' : 'form',
      passwordMode: combo.hashed ? 'hashed' : 'raw',
      httpStatus: null,
      errorCode: null,
      msg: null,
    };
    trace.push(attempt);

    this.logger.log(
      `client.ts: attemptLogin: trying contentType=${attempt.contentType} bodyFormat=${attempt.bodyFormat} passwordMode=${attempt.passwordMode}`,
    );

    let result;
    try {
      result = await this.decoInstance!.doEncryptedPost(';stok=/login', args, Buffer.from(JSON.stringify(loginReq)), true, sessionKey, this.sequence);
    } catch (e: any) {
      attempt.httpStatus = e?.httpStatus ?? null;
      attempt.msg = (e?.message ?? '').slice(0, 120) || null;

      if (e?.httpStatus === 403) {
        // A 403 on the login endpoint has two very different causes that look
        // identical from here: a genuinely busy admin session, or an account
        // the router has already locked (see the -5003 branch below — a locked
        // account answers 403 to everything that follows). Either way this is
        // not a format issue, so don't burn further combos on it; the caller
        // retries with backoff, and if a -5003 shows up in the same run the
        // LOCKED: path takes over and stops retrying altogether.
        this.logger.error('client.ts: attemptLogin: login rejected with 403 — session in use, or the account is locked out.');
        throw Object.assign(new Error('RETRY: Router rejected login (403). Will retry automatically.'), { cause: e, isBodyFormatError: false });
      }
      if (e?.isBodyFormatError) {
        // Firmware crashed parsing the request body (Lua exception) — this combo
        // is wrong, but the router needs a moment to recover before the next
        // attempt or it may reject that one too.
        this.logger.log('client.ts: attemptLogin: HTTP 500 body-format error (Lua crash) — waiting 1.5s for router recovery before trying next combo');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        throw Object.assign(new Error('FORMAT: body format rejected (firmware crash)'), { cause: e });
      }
      // Any other HTTP/network failure for this combo — not necessarily fatal,
      // could just be this combo confusing the firmware. Let the caller try
      // the next one; NETWORK: is only thrown for password/session key fetch
      // failures above (those happen before any combo-specific request).
      this.logger.log('client.ts: attemptLogin: request failed for this combo, trying next:', e?.message ?? e);
      throw Object.assign(new Error(`FORMAT: ${e?.message ?? 'request failed'}`), { cause: e });
    }

    attempt.httpStatus = 200;
    attempt.errorCode = result?.error_code ?? null;
    attempt.msg = result?.msg ?? null;
    this.logger.log('client.ts: attemptLogin: login response error_code:', result?.error_code, 'has stok:', !!result?.result?.stok);

    // error_code -5002 unambiguously means "wrong password" on every Deco
    // firmware seen so far (confirmed independently by the amosyuen/
    // ha-tplink-deco Home Assistant integration, which decodes the same
    // code) — the router parsed our request fine, this is never a format
    // issue. Surface the attempts-remaining count it provides instead of a
    // generic message, and stop trying other combos immediately: unlike a
    // missing-stok response with no error code (ambiguous between "wrong
    // combo" and "wrong password"), this code is decisive on its own.
    if (result?.error_code === -5002) {
      const attemptsAllowed = result?.result?.attemptsAllowed;
      const suffix = attemptsAllowed !== undefined ? ` (${attemptsAllowed} attempt${attemptsAllowed === 1 ? '' : 's'} remaining before a lockout)` : '';
      throw Object.assign(
        new Error(`CREDENTIALS: Wrong password${suffix}. Use the local admin password from the Deco app (not your TP-Link account password).`),
        { loginTrace: trace },
      );
    }

    // error_code -5003 means the router has temporarily locked the account after
    // too many failed logins. The response carries the counters that prove it:
    //   {"result":{"failureCount":10,"attemptsAllowed":0},"error_code":-5003}
    // This is NOT a format problem and NOT a concurrent-session problem, and
    // that distinction matters a lot in practice. Until now -5003 fell through
    // to the generic "missing stok" branch, so authenticate() moved on to the
    // next combo, spent the next login attempt, and eventually collected the
    // router's 403 — which attemptLogin() reported as "session limit". Users
    // were then told to close other Deco sessions or create a Manager account,
    // which cannot possibly help, while the retry loop kept hammering an
    // already-locked account and refreshed the lockout window on every pass.
    // Bail out on the first -5003 so the lockout gets a chance to expire.
    if (result?.error_code === -5003) {
      const failureCount = result?.result?.failureCount;
      const detail = failureCount !== undefined ? ` after ${failureCount} failed attempts` : '';
      this.logger.error(
        `client.ts: attemptLogin: router locked the account${detail} (error_code=-5003) — stopping all further attempts`,
      );
      throw Object.assign(
        new Error(
          `LOCKED: Your Deco has temporarily blocked new logins${detail}. This is the router's own protection and it clears by itself — wait about 15 minutes without trying again, then log in once. Trying repeatedly restarts the block.`,
        ),
        { loginTrace: trace },
      );
    }

    const newStok = result?.result?.stok;
    if (!newStok) {
      // Router understood the request (HTTP 200, valid response shape) but
      // didn't return a token — wrong combo or wrong credentials. Let the
      // caller decide which, once every combo has been exhausted.
      throw new Error(`FORMAT: login response missing stok (error_code=${result?.error_code}, msg=${result?.msg})`);
    }

    // Only update this.stok when we have a confirmed valid token. Assigning
    // before this point would clobber a previous valid stok with undefined on
    // a failed re-auth, causing concurrent devices on the shared client to use
    // stok=undefined in their request paths.
    this.stok = newStok;
    this.logger.log('client.ts: attemptLogin: login successful');
  }

  public async authenticate(password: string, _trace: LoginAttempt[] = []): Promise<boolean> {
    // Resolve hostname to IPv4 before making any HTTP requests.
    // Homey Pro (2023) has IPv6 enabled; tplinkdeco.net resolves to a
    // link-local IPv6 address causes redirect issues. Always use the IPv4 address.
    try {
      const { address } = await dns.lookup(this.host, { family: 4 });
      if (address !== this.host) {
        this.logger.log(`client.ts: authenticate: resolved ${this.host} → ${address} (IPv4 forced)`);
        this.host = address;
        this.c = new HttpClient(`http://${address}/cgi-bin/luci/`, HTTP_TIMEOUT_MS, this.logger);
      }
    } catch (e: any) {
      this.logger.log(`client.ts: authenticate: IPv4 DNS lookup failed for ${this.host} — using hostname as-is: ${e.message}`);
    }

    // No reachability pre-check here any more. pingHost() tried http:// and
    // then https:// with a 5s timeout each, and its result was never acted on:
    // a failed ping logged "proceeding with auth anyway" and carried straight
    // on to the login. On the meshes where this actually matters — where nodes
    // are slow or unresponsive — every ping timed out, so each re-auth paid a
    // flat ~10s for information nobody used. With several devices re-
    // authenticating in a loop that alone kept the router saturated. The login
    // request itself already reports unreachability, and does it faster.

    // Deliberately NOT clearing this.stok or the cookie jar here.
    //
    // That was tried, to fix a report of a rebooted X20 never reconnecting. It
    // reintroduces the bug the comment further down in attemptLogin() warns
    // about: one DecoAPIWraper is shared by every device in a mesh, and polls
    // are not serialised against authenticate(). Blanking the token mid-flight
    // makes sibling devices send `;stok=/admin/...`, read the empty result as
    // "session expired", and start re-authenticating themselves — an
    // amplification loop against a router that allows one admin session, which
    // is precisely the failure this release exists to stop. The reboot theory
    // was also never verified: a rebooted router issues a fresh Set-Cookie on
    // the next successful login anyway.
    //
    // MD5(admin+rawPassword) — computed once; combos that need the hashed
    // password reuse this rather than re-hashing.
    this.hash = crypto.createHash('md5').update(`${userName}${password}`).digest('hex');

    // Snapshot the cached/known-good combo *before* attemptLogin() gets a
    // chance to mutate this.c.forceJsonContentType/forceJsonBody. attemptLogin
    // overwrites those fields on every attempt — including failed ones — so
    // reading them after even one failure would anchor buildLoginCombos() on
    // whatever combo happened to be active when we stopped, not the combo
    // that's actually known to work for this router.
    const baselineCombo = { contentType: this.c.forceJsonContentType, jsonBody: this.c.forceJsonBody };
    const combos = this.buildLoginCombos(baselineCombo);
    let lastError: any = null;

    // Homey's own pairing UI enforces a hard ~30s timeout on the 'login' RPC
    // call from the frontend — if we don't resolve within that window, the
    // user sees a generic "Timeout after 30000ms" alert even if the backend
    // goes on to succeed a moment later. Trying multiple combos (each with
    // its own password-key/session-key/login round trips) can add up past
    // that ceiling on a slow router, so stop trying further combos once
    // we're past a safe budget and fail fast with a clear error instead of
    // silently exceeding Homey's own timeout.
    const deadline = Date.now() + 25000;

    // Restores this.c to the pre-attempt baseline before any failure exit.
    // Without this, a thrown RETRY: (403 session-limit) leaves whatever combo
    // was active on the shared HttpClient — e.g. jsonBody flipped on after an
    // earlier HTTP 500 — permanently stuck there. The outer pairing retry loop
    // in driver.ts calls authenticate() again, buildLoginCombos() reads that
    // poisoned state as "current", and every subsequent retry (all the way
    // through the 403 backoff schedule) keeps re-trying the same wrong combo
    // instead of ever getting a fair shot at the others.
    const restoreBaseline = () => {
      this.c.forceJsonContentType = baselineCombo.contentType;
      this.c.forceJsonBody = baselineCombo.jsonBody;
    };

    for (const combo of combos) {
      if (Date.now() > deadline) {
        this.logger.error('client.ts: authenticate: stopping combo attempts — over time budget, router is responding too slowly.');
        restoreBaseline();
        throw Object.assign(
          new Error(`NETWORK: Router at ${this.host} is responding too slowly to complete login. Try again, or check the connection.`),
          { loginTrace: _trace, cause: lastError },
        );
      }
      try {
        await this.attemptLogin(password, combo, _trace);
        return true;
      } catch (e: any) {
        const msg: string = e?.message ?? '';

        // A 403 arriving *after* this router has already shown us it can't parse
        // our requests is not a session limit, whatever it looks like in
        // isolation. One reported XE75 Pro is the case: combos 1-2 crashed the
        // firmware's Lua interpreter outright ("Failed to execute call dispatcher
        // target for entry '/login'" behind an HTTP 500), combos 3-4 came back
        // error_code 1 "no such callback", and only the fifth answered 403 — which
        // we reported as "another session is already active". The user had already
        // tried two accounts and confirmed the local web login worked, so that
        // advice could not possibly help.
        //
        // This used to abort the whole round immediately and report an
        // unrecognised protocol — but four more reports since (X55, 4×BE65 Pro,
        // XE75 Pro again) showed that 403 landing at combo 5 of 6, one combo
        // short of the untried contentType=json/bodyFormat=json/passwordMode=
        // hashed combination every single time. Aborting there means the one
        // combo most likely to actually be this firmware's correct format never
        // gets a chance. Treat this 403 like any other format failure instead —
        // try the remaining combo(s) before giving up — since a 403 immediately
        // following firmware-level parse failures is at least as likely to be
        // more of the same rejection (or the account being rate-limited by the
        // burst of failed attempts) as it is a genuine concurrent-session lock.
        if (msg.startsWith('RETRY:')) {
          const firmwareRejectedOurFormats = _trace.some(
            (a) => a.httpStatus === 500 || (a.msg ?? '').includes('no such callback'),
          );
          if (firmwareRejectedOurFormats) {
            this.logger.log(
              'client.ts: authenticate: 403 after firmware-level format rejections — treating as a format failure, trying remaining combos instead of aborting.',
            );
            lastError = e;
            if (combo !== combos[combos.length - 1]) {
              await new Promise((resolve) => setTimeout(resolve, 800));
            }
            continue;
          }
        }

        if (
          msg.startsWith('NETWORK:') ||
          msg.startsWith('RETRY:') ||
          msg.startsWith('CREDENTIALS:') ||
          msg.startsWith('LOCKED:')
        ) {
          // Not a format issue — bail immediately rather than burning more
          // login attempts against an unreachable, session-limited, or (per
          // error_code -5002 above) definitively wrong-password router.
          restoreBaseline();
          throw Object.assign(e, { loginTrace: _trace });
        }
        lastError = e;
        // Anything else (FORMAT:/RSA failure/etc.) — try the next combo, but
        // not immediately. Each combo is 3 requests (password key, session
        // key, login POST); with no delay, a genuinely unrecognised router
        // gets hit with up to ~18 login-related POSTs in well under a
        // second — a burst that looks identical to a brute-force script to
        // most routers' rate-limiting, and can trip a temporary IP lockout
        // that then shows up as persistent 403s on every later attempt
        // (including from this same Homey, but not from someone's browser
        // on a different device/IP — which is why "I can log in fine via
        // the web UI" doesn't contradict this). Pace combo attempts like a
        // human trying a few times, not a script hammering the endpoint.
        if (combo !== combos[combos.length - 1]) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
    }

    // Every combo failed. If at least one attempt got a clean HTTP 200 with a
    // recognisable response shape, the router understood our requests fine —
    // this is a wrong-password case, not an unrecognised protocol. Otherwise
    // nothing about this firmware's login matched any known combo.
    const anyFormatUnderstood = _trace.some((a) => a.httpStatus === 200);
    this.logger.error('client.ts: authenticate: all login combos exhausted.', JSON.stringify(_trace));
    restoreBaseline();
    if (anyFormatUnderstood) {
      // We know the router parsed at least one request (some attempt got a clean
      // HTTP 200) and that none returned a token. That is NOT enough to assert
      // the password is wrong, and we used to say so outright. Two users with
      // X50 fw 1.8.0 and one with an X55 were told "Wrong password" while the
      // same password signed them in at tplinkdeco.net in a browser — and a
      // definitely-wrong password has its own signal anyway (error_code -5002,
      // handled above with the attempts-remaining count). Say what we actually
      // observed and point at the check the user can perform themselves.
      throw Object.assign(
        new Error(
          `CREDENTIALS: The router turned down the login without saying why. Check the password by opening http://${this.host} in a browser and signing in there — if that works, this is a fault in the app rather than your password, and a diagnostic report would help.`,
        ),
        { loginTrace: _trace, cause: lastError },
      );
    }
    throw Object.assign(new Error(`All login formats failed for ${this.host}.`), { loginTrace: _trace, cause: lastError });
  }

  // Public method to retrieve Wan data
  async getAdvancedSettings(): Promise<AdvancedResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting advanced data...');
    const args = new EndpointArgs('power');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const response = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/wireless`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      response &&
      typeof response === 'object' &&
      'errorcode' in response &&
      'success' in response
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: response.errorcode,
        success: response.success,
      };
      // this.logger.log('client.ts: ' + 'Advanced request failed:', errorResponse);
      return errorResponse;
    }
    return response;
  }
  // Public method to retrieve Wan data
  async getWLAN(): Promise<WLANNetworkResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('wlan');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const response = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/wireless`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      response &&
      typeof response === 'object' &&
      'errorcode' in response &&
      'success' in response
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: response.errorcode,
        success: response.success,
      };
      // this.logger.log('client.ts: ' + 'WLAN request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    const decodeBase64 = (encoded: string): string => {
      try {
        return Buffer.from(encoded, 'base64').toString('utf-8');
      } catch (e) {
        // this.logger.log('client.ts: ' + `Failed to decode base64 string: ${encoded}`,e,);
        return encoded; // Returnera den ursprungliga strängen om dekodning misslyckas
      }
    };

    // Dekodera band5_1
    response.result.band5_1.guest.ssid = decodeBase64(
      response.result.band5_1.guest.ssid,
    );
    response.result.band5_1.guest.password = decodeBase64(
      response.result.band5_1.guest.password,
    );
    response.result.band5_1.host.ssid = decodeBase64(
      response.result.band5_1.host.ssid,
    );
    response.result.band5_1.host.password = decodeBase64(
      response.result.band5_1.host.password,
    );

    // Dekodera band2_4
    response.result.band2_4.guest.ssid = decodeBase64(
      response.result.band2_4.guest.ssid,
    );
    response.result.band2_4.guest.password = decodeBase64(
      response.result.band2_4.guest.password,
    );
    response.result.band2_4.host.ssid = decodeBase64(
      response.result.band2_4.host.ssid,
    );
    response.result.band2_4.host.password = decodeBase64(
      response.result.band2_4.host.password,
    );

    // this.logger.log( 'client.ts: ' + 'Processed WLAN network response: ',JSON.stringify(response),);

    return response;
  }

  // Public method to retrieve LAN data
  async getLAN(): Promise<any> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('lan_ip');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'LAN request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve Wan data
  async getWAN(): Promise<WANResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('wan_ipv4');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'WAN request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }
  // Public method to retrieve Internt data
  async getInternet(): Promise<InternetResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('internet');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Internet request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve enviromet data
  async getModel(): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('model');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/device`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Model request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve enviromet data
  async getEnviroment(): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('envar');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/system`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Enviromet request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }
  // Public method to retrieve status data
  async getStatus(): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('all');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/status`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Status request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve firmware data
  async firmware(): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting firmware data...');
    const args = new EndpointArgs('upgrade');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/firmware`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Firmware request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve performance data
  async performance(): Promise<PerformanceResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting performance data...');
    const args = new EndpointArgs('performance');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as PerformanceResponse;

    // Check if result is an error
    if (isErrorResponse(result)) {
      // this.logger.log('client.ts: ' + 'Performance request failed:', result);
      return result;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve the list of devices
  async deviceList(): Promise<DeviceListResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting device list...');
    const args = new EndpointArgs('device_list');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/device`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as DeviceListResponse;

    // Check if result is an error
    if (isErrorResponse(result)) {
      // this.logger.log('client.ts: ' + 'device list request failed:', result);
      return result;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve the list of clients
  async clientList(): Promise<ClientListResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting client list...');
    const args = new EndpointArgs('client_list');
    const request: RequestParams = {
      operation: 'read',
      params: { device_mac: 'default' },
    };

    const jsonRequest = JSON.stringify(request);
    // this.logger.log('client.ts: ' + `Client list request JSON: ${jsonRequest}`);
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    let result: ClientListResponse;
    try {
      result = (await decoInstance.doEncryptedPost(
        `;stok=${this.stok}/admin/client`,
        args,
        Buffer.from(jsonRequest),
        false,
      )) as ClientListResponse;
    } catch (error) {
      // this.logger.log('client.ts: ' + 'client list request failed:', error);
      result = { error_code: 1, result: { client_list: [] } }; // Return default values in case of error
    }

    // Check if result is an error
    if (isErrorResponse(result)) {
      // this.logger.log('client.ts: ' + 'client list request failed:', result);
      return result;
    }

    // this.logger.log('client.ts: ' + 'Processing client list response...');
    try {
      // Uppdatera client_list med dekodade namn
      result.result.client_list.forEach((client) => {
        try {
          // Försök att dekoda namnet
          const decodedName = Buffer.from(client.name, 'base64').toString(
            'utf-8',
          );
          // this.logger.log('client.ts: ' + `Decoded client name: ${decodedName}`);

          // Sätt det dekodade namnet till klienten
          client.name = decodedName;
        } catch (e) {
          // Logga fel om dekodningen misslyckas
          // this.logger.log('client.ts: ' + `Failed to decode client name: ${client.name}`,e,);
        }
      });
      // this.logger.log('client.ts: ' + 'Processed client list response: ',JSON.stringify(result),);
      // Returnera det uppdaterade resultatet
      return result;
    } catch (e) {
      // this.logger.log('client.ts: ' + 'client list request failed:', e);
      return { error_code: 1, result: { client_list: [] } }; // Return default values in case of error
    }
  }

  // Public method to reboot devices based on their MAC addresses
  async reboot(...macAddrs: string[]): Promise<{ [key: string]: any }> {
    // this.logger.log('client.ts: ' +`Requesting reboot for MAC addresses: ${macAddrs.join(', ')}`,);
    const macList = macAddrs.map((mac) => ({ mac: mac.toUpperCase() }));
    const request: RequestParams = {
      operation: 'reboot',
      params: {
        mac_list: macList,
      },
    };

    const jsonRequest = JSON.stringify(request);
    // this.logger.log('client.ts: ' + `Reboot request JSON: ${jsonRequest}`);
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );

    const args = new EndpointArgs('system');
    return (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/device`,
      args,
      Buffer.from(jsonRequest),
      false,
    )) as { [key: string]: any };
  }

  // Public method to send a custom request to a specific endpoint
  async custom(
    path: string,
    params: EndpointArgs,
    body: Buffer,
    silent: boolean = false,
  ): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + `Sending custom request to path: ${path}`);
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}${path}`,
      params,
      body,
      false,
      undefined,
      undefined,
      silent,
    )) as any;

    // Check if result is an error
    if (isErrorResponse(result)) {
      // this.logger.log('client.ts: ' + 'client list request failed:', result);
      return result;
    }
    return result;
  }
}

// Function to extract and print details from an RSA KeyObject
function printKey(keyObject: KeyObject): string {
  // Export the key as a DER-encoded buffer
  const keyBuffer = keyObject.export({ type: 'pkcs1', format: 'der' });

  // The modulus for RSA keys is stored in the first part of the key structure
  // Parse the modulus by skipping the header bytes in the DER-encoded key
  const modulusOffset = 29; // Skip the header bytes (this offset can vary slightly)
  const modulusLength = keyBuffer.readUInt16BE(modulusOffset - 2); // Read the modulus length

  // Extract the modulus
  const modulus = keyBuffer.slice(modulusOffset, modulusOffset + modulusLength);

  return (
    'Modulus (hex): ' +
    modulus.toString('hex') +
    'Exponent: ' +
    keyObject.asymmetricKeyDetails?.publicExponent
  );
}

// Type guard för att kontrollera om ett objekt är av typen ErrorResponse
function isErrorResponse(result: any): result is ErrorResponse {
  return (
    typeof result === 'object' &&
    result !== null &&
    'errorcode' in result &&
    'success' in result &&
    typeof result.errorcode === 'string' &&
    typeof result.success === 'boolean'
  );
}
