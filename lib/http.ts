import { CookieJar } from 'tough-cookie';

interface PostConfig {
  method: 'POST';
  url: string;
  data: Buffer;
  headers: Record<string, string>;
  params: { form: string };
}

export interface AppLogger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

const consoleLogger: AppLogger = { log: console.log, error: console.error };

/**
 * Minimal HTTP client using the Node.js native fetch API with tough-cookie
 * for session cookie management. Handles HTTP→HTTPS redirects automatically
 * (newer Deco firmware enforces HTTPS). TLS verification is disabled globally
 * via NODE_TLS_REJECT_UNAUTHORIZED=0 set in app.ts.
 */
export class HttpClient {
  private readonly jar: CookieJar;
  private readonly logger: AppLogger;
  // Not readonly — may be upgraded from http:// to https:// on first redirect
  baseURL: string;
  private readonly timeout: number;
  /**
   * Content-Type to use for doEncryptedPost over HTTPS: application/json when
   * true, application/x-www-form-urlencoded when false. This only decides
   * which combo client.ts's authenticate() tries FIRST for a brand-new
   * device — every combo is tried regardless (see buildLoginCombos), so this
   * default is purely a speed optimisation, never a correctness requirement.
   * Defaults to true based on two independent real-browser HAR captures
   * (different routers, different networks, 2026-06-25/26) both showing
   * Content-Type: application/json from the first request, corroborated by
   * "Auth method reported" telemetry across ~16 distinct models showing the
   * same combo as the eventual working one in the large majority of cases.
   * (This was briefly reverted to false in v1.4.59 after a report that looked
   * like a content-type regression on X50-4G — but that was during the same
   * window session.nextView(viewId) was silently ignoring its argument
   * [fixed v1.4.61], which alone explains a "successful login that never
   * shows devices to add". Telemetry since confirms X50-4G's actual working
   * combo is contentType=json, so the original regression report likely
   * wasn't a content-type issue at all.)
   */
  public forceJsonContentType: boolean = true;
  /**
   * When true, doEncryptedPost sends the body as JSON {"sign":"...","data":"..."}
   * instead of the default URL-encoded form "sign=...&data=...". Required by
   * newer Deco firmware (e.g. X50 fw 1.8.0) that strictly parses the body
   * according to Content-Type and crashes (HTTP 500 Lua error) on form data
   * sent with application/json Content-Type.
   */
  public forceJsonBody: boolean = false;

  constructor(baseURL: string, timeout = 10000, logger: AppLogger = consoleLogger) {
    this.jar = new CookieJar();
    this.baseURL = baseURL;
    this.timeout = timeout;
    this.logger = logger;
  }

  async request(config: PostConfig): Promise<{ data: any }> {
    const paramStr = `?form=${encodeURIComponent(config.params.form)}`;

    const cookieStr = await this.jar.getCookieString(this.baseURL);
    this.logger.log(
      `http.ts: POST ${config.url}?form=${config.params.form}`,
      `body=${config.data.length}B`,
      cookieStr ? `cookies=yes(${cookieStr.split(';').length})` : 'cookies=none',
    );
    // Logged separately from the line above (rather than inlined) so a diagnostic
    // report alone is enough to confirm the exact request shape against a real
    // browser HAR capture — no need to ask the reporter for a fresh HAR just to
    // check headers again, the way we had to for the Content-Type/Origin/Referer
    // investigation this week.
    this.logger.log('http.ts: request headers:', JSON.stringify(config.headers));

    // Up to 2 attempts: first over http, then https if the router redirects.
    // redirect:'manual' prevents the runtime from re-reading the POST body on redirect.
    for (let attempt = 0; attempt < 2; attempt++) {
      const urlStr = `${this.baseURL}${config.url}${paramStr}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      // Backstop: undici's fetch has been observed not honoring AbortController
      // during the DNS-resolution/connect phase (a known Node 22 quirk — see
      // reference_homey_sdk_docs memory), letting a request hang well past
      // `this.timeout` regardless of the abort signal. A request that hangs to
      // ~30s blows straight through Homey's own hard 30s pairing RPC limit,
      // showing the user a "Timeout after 30000ms" alert even when the login
      // eventually succeeds a moment too late. Race a plain timer alongside
      // the abort-based one so a hang is bounded no matter what fetch does.
      let hardTimer: NodeJS.Timeout;
      const hardTimeout = new Promise<never>((_, reject) => {
        hardTimer = setTimeout(() => reject(Object.assign(new Error('ETIMEDOUT'), { name: 'AbortError' })), this.timeout + 2000);
      });

      let response: Response;
      try {
        response = await Promise.race([
          fetch(urlStr, {
            method: 'POST',
            headers: {
              ...config.headers,
              ...(cookieStr ? { Cookie: cookieStr } : {}),
            },
            // Always use a fresh copy so retries after a redirect still have the body.
            body: Buffer.from(config.data),
            signal: controller.signal,
            redirect: 'manual',
          } as RequestInit),
          hardTimeout,
        ]);
      } catch (e: any) {
        clearTimeout(timer);
        clearTimeout(hardTimer!);
        const causeCode = e?.cause?.code ?? e?.code;
        const label = e?.name === 'AbortError' ? 'ETIMEDOUT' : (causeCode ?? e?.message);
        this.logger.error(`http.ts: network error for "${config.url}?form=${config.params.form}": ${label}`);
        // Most firmware that requires HTTPS answers a plain-http request with
        // a 307 redirect, which the block above upgrades baseURL from. Some
        // newer firmware instead doesn't listen on port 80 at all — a field
        // report (2026-09-23, homey5q) showed every login attempt failing
        // instantly with ECONNREFUSED on port 80, forever, since there's no
        // redirect response to upgrade from and the device never recovers on
        // its own. A refused connection fails fast, unlike a timeout (which
        // already pays the full budget — retrying that over https too would
        // double the wait for a router that's genuinely offline), so retry
        // immediately over https instead of throwing.
        if (attempt === 0 && this.baseURL.startsWith('http://') && causeCode === 'ECONNREFUSED') {
          this.logger.log('http.ts: connection refused on http:// — retrying immediately over https://');
          this.baseURL = this.baseURL.replace(/^http:\/\//, 'https://');
          continue;
        }
        throw e;
      }

      clearTimeout(timer);
      clearTimeout(hardTimer!);

      // Handle HTTP→HTTPS (or other) redirects manually.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? '';
        this.logger.log(`http.ts: redirect ${response.status} → ${location} (upgrading baseURL)`);
        if (location.startsWith('https://')) {
          // Upgrade baseURL so all subsequent requests in this session use HTTPS.
          this.baseURL = this.baseURL.replace(/^http:\/\//, 'https://');
        } else if (location) {
          // Unexpected redirect target — log and abort rather than loop.
          throw Object.assign(new Error(`Unexpected redirect to ${location}`), { httpStatus: response.status });
        }
        // Retry the request with the updated baseURL.
        continue;
      }

      // --- normal response handling ---
      const rawHeaders = response.headers as any;
      const setCookies: string[] =
        typeof rawHeaders.getSetCookie === 'function'
          ? rawHeaders.getSetCookie()
          : [];
      if (setCookies.length > 0) {
        this.logger.log(`http.ts: received ${setCookies.length} Set-Cookie header(s)`);
        for (const cookie of setCookies) {
          await this.jar.setCookie(cookie, this.baseURL).catch(() => {});
        }
      }

      const rawText = await response.text();

      if (!response.ok) {
        this.logger.error(
          `http.ts: HTTP ${response.status} for "${config.url}?form=${config.params.form}"`,
          `body=${rawText.slice(0, 200)}`,
        );
        const err: any = new Error(`HTTP ${response.status}`);
        err.httpStatus = response.status;
        // Attach the raw body so callers that handle encrypted responses
        // (e.g. doEncryptedPost) can attempt decryption to get the real error code.
        err.responseBody = rawText;
        throw err;
      }

      this.logger.log(`http.ts: HTTP ${response.status} for "${config.url}?form=${config.params.form}" body=${rawText.length}B`);

      try {
        return { data: JSON.parse(rawText) };
      } catch (parseErr) {
        this.logger.error(
          `http.ts: JSON parse failed for "${config.url}?form=${config.params.form}" HTTP ${response.status}`,
          `raw=${rawText.slice(0, 300)}`,
        );
        throw parseErr;
      }
    }

    // Should never reach here (loop always returns or throws).
    throw new Error('http.ts: request loop exhausted without response');
  }
}
