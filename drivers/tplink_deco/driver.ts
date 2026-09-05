'use strict';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import os from 'os';
import { Driver } from 'homey';
import decoapiwrapper, { AppLogger, DeviceListResponse, LoginAttempt } from '../../lib/client';

// Backoff schedule for the router's "session limit" 403 (RETRY:). The router
// only releases a stale admin session after its own internal timeout, which
// has been observed to exceed the previous flat 3×3s window on some hardware
// (e.g. Homey Pro mini / homey6q reports). Escalating delays give the router
// more time to expire the old session before giving up.
const SESSION_LIMIT_RETRY_BACKOFF_MS = [3000, 5000, 8000, 12000];

// This schedule's delays alone sum to 28s — already over Homey's own ~30s
// hard timeout on the pairing 'login'/'repair' RPC call, before counting any
// actual request time. A user confirmed this in practice: the frontend's
// "Timeout after 30000ms" alert fired mid-pairing while the backend kept
// retrying in the background and went on to succeed anyway — confusing, since
// the dialog implies failure but pairing actually completes. Cap the total
// time spent in the retry loop so it reliably resolves (success or a clear
// friendly error) well before Homey gives up, instead of working past a
// deadline the frontend has already abandoned.
const PAIRING_RETRY_DEADLINE_MS = 20000;

class TplinkDecoDriver extends Driver {
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;
  private api: decoapiwrapper | any;

  // Buffer for read operations
  readBody = Buffer.from('{"operation": "read"}');

  // One shared DecoAPIWrapper per master hostname so all device instances
  // use a single session (the Deco only allows one active session at a time).
  private sharedApis = new Map<string, decoapiwrapper>();
  // Serializes concurrent authenticate() calls for the same hostname so
  // multiple devices detecting "session expired" at the same time don't race.
  private authQueue = new Map<string, Promise<boolean>>();
  // Tracks hostnames for which network diagnostics have already been logged
  // this session, so re-auth cycles don't flood the log.
  private diagRan = new Set<string>();

  // Per-hostname, per-node-MAC client lists, populated by each device's own
  // regular poll (device_mac: <own MAC>, confirmed working in the field).
  // The previous mesh-wide approach used device_mac: 'default' and consistently
  // returned error_code=1 across ~14 models in our own telemetry — note other
  // TP-Link Deco integrations (e.g. amosyuen/ha-tplink-deco) document 'default'
  // as a supported value, so it may work on some firmware/models and not others,
  // or there's a request-shape difference we're not replicating. Either way,
  // merging confirmed-working per-node data sidesteps the question entirely and
  // costs zero extra API calls.
  private nodeClientLists = new Map<string, Map<string, any[]>>();

  /**
   * Drops every piece of driver-level state that outlives a single device:
   * the shared API clients (each holding a router session and cookie jar), the
   * in-flight auth promises, the per-hostname diagnostics flags and the merged
   * per-node client lists. Called from the app's onUninit — see the comment
   * there for the crash report that prompted it.
   */
  public releaseResources(): void {
    this.sharedApis.clear();
    this.authQueue.clear();
    this.diagRan.clear();
    this.nodeClientLists.clear();
    this.api = undefined;
    this.log('Driver resources released');
  }

  /**
   * Returns (or lazily creates) the shared API instance for a given hostname.
   * Devices should always call this instead of `new decoapiwrapper(...)`.
   */
  public getOrCreateSharedApi(hostname: string, logger: AppLogger): decoapiwrapper {
    if (!this.sharedApis.has(hostname)) {
      this.sharedApis.set(hostname, new decoapiwrapper(hostname, logger));
    }
    return this.sharedApis.get(hostname)!;
  }

  /**
   * Records the most recent client list a single node reported for itself
   * (device_mac: <own MAC>). Called by every device on each poll cycle.
   */
  public setNodeClientList(hostname: string, nodeMac: string, clients: any[]): void {
    if (!this.nodeClientLists.has(hostname)) {
      this.nodeClientLists.set(hostname, new Map());
    }
    this.nodeClientLists.get(hostname)!.set(nodeMac.toUpperCase(), clients);
  }

  /**
   * Merges the most recently reported per-node client lists for a hostname into
   * one mesh-wide list — this is the data the master device needs for
   * join/leave-anywhere-in-the-mesh detection, built from data every node
   * already fetches for itself rather than a dedicated "mesh-wide" API call.
   */
  public getMeshClientList(hostname: string): any[] {
    const byNode = this.nodeClientLists.get(hostname);
    if (!byNode) return [];
    const merged: any[] = [];
    for (const clients of byNode.values()) {
      if (Array.isArray(clients)) merged.push(...clients);
    }
    return merged;
  }

  /**
   * Authenticates the shared API for a hostname.
   * If an auth is already in progress (from another device instance),
   * returns the same promise so only ONE login hits the router.
   */
  public async sharedAuthenticate(hostname: string, password: string, logger: AppLogger): Promise<boolean> {
    const inFlight = this.authQueue.get(hostname);
    if (inFlight) {
      this.log(`sharedAuthenticate: auth already in progress for ${hostname}, waiting`);
      return inFlight;
    }
    if (!this.diagRan.has(hostname)) {
      this.diagRan.add(hostname);
      await this.logNetworkDiagnostics(hostname);
    }
    const api = this.getOrCreateSharedApi(hostname, logger);
    const promise = api.authenticate(password).finally(() => this.authQueue.delete(hostname));
    this.authQueue.set(hostname, promise);
    return promise;
  }

  /**
   * Logs network diagnostics for a given hostname/IP.
   * Call this before any authentication attempt so the data always
   * appears in diagnostics reports, even when the connection fails.
   */
  public async logNetworkDiagnostics(hostname: string): Promise<void> {
    // Homey's own local IPv4 interfaces (address + mask)
    const ifaces = os.networkInterfaces();
    const localIfaces = (Object.values(ifaces) as (os.NetworkInterfaceInfo[] | undefined)[])
      .flat()
      .filter((i): i is os.NetworkInterfaceInfo => !!i && !i.internal && i.family === 'IPv4');

    if (localIfaces.length === 0) {
      this.log(`[diag] Homey local IPs: none found`);
    } else {
      for (const iface of localIfaces) {
        this.log(`[diag] Homey local IP: ${iface.address}  mask: ${iface.netmask}  cidr: ${iface.cidr ?? 'n/a'}`);
      }
    }
    this.log(`[diag] Target hostname: ${hostname}`);

    // DNS resolution — show both IPv4 and IPv6 so address-family issues are obvious
    let resolvedIP: string | null = null;
    try {
      const { address } = await dns.lookup(hostname, { family: 4 });
      resolvedIP = address;
      this.log(`[diag] DNS IPv4: ${hostname} → ${address}`);
    } catch (e: any) {
      this.log(`[diag] DNS IPv4: ${hostname} failed — ${e.message}`);
    }
    try {
      const { address } = await dns.lookup(hostname, { family: 6 });
      this.log(`[diag] DNS IPv6: ${hostname} → ${address}${resolvedIP ? ' (will use IPv4 above)' : ' (no IPv4 — this is the problem!)'}`);
    } catch {
      // no IPv6 record — fine
    }
    if (!resolvedIP) {
      this.log(`[diag] DNS: ${hostname} has no IPv4 address — TCP check skipped`);
      return;
    }

    // Subnet match using each interface's actual netmask (not a hardcoded /24).
    // Converts IP and mask to 32-bit integers and compares network addresses,
    // so a /22 mask (255.255.252.0) spanning e.g. 192.168.68–71.x is handled correctly.
    const ipToInt = (ip: string) =>
      ip.split('.').reduce((acc, o) => ((acc << 8) | parseInt(o, 10)) >>> 0, 0);

    const matched = localIfaces.find((iface) => {
      const m = ipToInt(iface.netmask);
      return (ipToInt(iface.address) & m) === (ipToInt(resolvedIP!) & m);
    });

    if (matched) {
      this.log(`[diag] Subnet: OK — Homey (${matched.address}/${matched.netmask}) and router (${resolvedIP}) are on the same network`);
    } else {
      const homeyList = localIfaces.map((i) => `${i.address}/${i.netmask}`).join(', ');
      this.log(`[diag] Subnet: MISMATCH — Homey [${homeyList}] cannot reach router ${resolvedIP}. Check VLANs / guest network isolation.`);
    }

    // TCP reachability on both ports the Deco web interface may use. Run them
    // concurrently: they are independent, and this runs inside the pairing
    // 'login' RPC whose ~30s budget is shared with the login itself. Sequential
    // 3s timeouts spent up to 6s here before a single login request went out —
    // on a large mesh that is a meaningful slice of the budget, and a user with
    // six nodes did report hitting Homey's 30s timeout.
    const [tcpOk, tcpOk443] = await Promise.all([
      this.checkTcpPort(resolvedIP, 80),
      this.checkTcpPort(resolvedIP, 443),
    ]);
    this.log(`[diag] TCP port 80 → ${resolvedIP}: ${tcpOk ? 'reachable' : 'UNREACHABLE'}`);
    this.log(`[diag] TCP port 443 → ${resolvedIP}: ${tcpOk443 ? 'reachable' : 'UNREACHABLE'}`);
  }

  private checkTcpPort(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, host);
    });
  }

  private makeLogger(): AppLogger {
    return {
      log: (...args: any[]) => this.log(...args),
      error: (...args: any[]) => this.error(...args),
    };
  }

  /**
   * Called when the driver is initialized.
   * Checks if API settings are available; if not, waits for user input.
   */
  async onInit() {
    this.log('TP-Link Deco Driver has been initialized');

    // Register condition: client is online
    // Registered once here so multiple device instances don't overwrite each other.
    // Uses the persistent trackedClients store so the condition works even for clients
    // that are currently offline (returns false) but have been seen in the last 30 days.
    const clientIsOnline = this.homey.flow.getConditionCard('client_is_online');
    clientIsOnline.registerRunListener(async (args) => {
      const device = args.device as any;
      const tracked = device?.trackedClients ?? {};
      return tracked[args.client.mac]?.online === true;
    });
    clientIsOnline.registerArgumentAutocompleteListener(
      'client',
      async (query, args) => {
        return this.buildClientAutocomplete(args.device, query);
      },
    );

    // Register autocomplete for client_state_changed trigger
    // Registered once here so multiple device instances don't overwrite each other.
    const clientStateFlow = this.homey.flow.getDeviceTriggerCard('client_state_changed');
    clientStateFlow.registerArgumentAutocompleteListener(
      'client',
      async (query, args) => {
        return this.buildClientAutocomplete(args.device, query);
      },
    );

    // Mesh-wide presence — global cards (no device argument), since "the mesh" isn't a
    // property of any single Deco node. Data is sourced from the master device's
    // meshTrackedClients, populated by its device_mac: 'default' poll (see device.ts).
    const clientJoinedMeshFlow = this.homey.flow.getTriggerCard('client_joined_mesh');
    clientJoinedMeshFlow.registerRunListener(async (args, state) => {
      return args.client.mac === state.mac;
    });
    clientJoinedMeshFlow.registerArgumentAutocompleteListener(
      'client',
      async (query) => this.buildMeshClientAutocomplete(query),
    );

    const clientLeftMeshFlow = this.homey.flow.getTriggerCard('client_left_mesh');
    clientLeftMeshFlow.registerRunListener(async (args, state) => {
      return args.client.mac === state.mac;
    });
    clientLeftMeshFlow.registerArgumentAutocompleteListener(
      'client',
      async (query) => this.buildMeshClientAutocomplete(query),
    );

    const clientPresentInMesh = this.homey.flow.getConditionCard('client_present_in_mesh');
    clientPresentInMesh.registerRunListener(async (args) => {
      const master = this.getMasterDevice();
      return master?.meshTrackedClients?.[args.client.mac]?.online === true;
    });
    clientPresentInMesh.registerArgumentAutocompleteListener(
      'client',
      async (query) => this.buildMeshClientAutocomplete(query),
    );
  }

  /**
   * Finds the paired device representing the mesh's master node, which is the only
   * device that maintains meshTrackedClients. Returns undefined if no master is paired.
   */
  private getMasterDevice(): any | undefined {
    return this.getDevices().find(
      (d: any) => (d.getSettings?.().role ?? '').toLowerCase() === 'master',
    );
  }

  /**
   * Builds an autocomplete result list from the master device's mesh-wide client history.
   * Mirrors buildClientAutocomplete, but sourced mesh-wide instead of per-node.
   */
  public buildMeshClientAutocomplete(query: string) {
    const master = this.getMasterDevice();
    const trackedCount = master ? Object.keys(master.meshTrackedClients ?? {}).length : 0;
    this.log(`buildMeshClientAutocomplete: master=${master ? master.getName() : 'NOT FOUND'} trackedClients=${trackedCount}`);
    return this.buildClientAutocompleteFrom(master?.meshTrackedClients ?? {}, query);
  }

  /**
   * Builds an autocomplete result list from a device's tracked client history.
   * Shows all clients seen in the last 30 days (online and offline).
   * Online clients are shown first; offline clients show their last-seen date.
   */
  public buildClientAutocomplete(device: any, query: string) {
    return this.buildClientAutocompleteFrom(device?.trackedClients ?? {}, query);
  }

  /**
   * Shared filtering/sorting logic behind buildClientAutocomplete and
   * buildMeshClientAutocomplete — only the source tracked-client map differs.
   */
  private buildClientAutocompleteFrom(tracked: Record<string, any>, query: string) {
    const search = query.toLowerCase();

    return Object.values(tracked)
      .filter(
        (c) =>
          c.mac.toLowerCase().includes(search) ||
          c.name.toLowerCase().includes(search) ||
          (c.ip ?? '').toLowerCase().includes(search),
      )
      .sort((a, b) => {
        // Online clients first, then by lastSeen descending
        if (a.online !== b.online) return a.online ? -1 : 1;
        return b.lastSeen - a.lastSeen;
      })
      .map((c) => ({
        name: c.name || c.mac,
        mac: c.mac,
        description: c.online
          ? `${c.mac} — online`
          : `${c.mac} — last seen ${new Date(c.lastSeen).toLocaleDateString()}`,
      }));
  }

  /**
   * Handles the pairing process for adding a new TP-Link Deco device.
   * @param session - The pairing session object provided by Homey.
   */
  async onPair(session: any): Promise<void> {
    this.log('Starting pairing process');

    let hostname = '';
    let password = '';
    let lastLoginTrace: LoginAttempt[] = [];

    // Received when a view has changed
    session.setHandler('showView', async (viewId: string) => {
      this.log('pair: view shown:', viewId);
    });

    // Serves the localized strings for our own login_credentials view. We no
    // longer use Homey's built-in login_credentials template (its script calls
    // Homey.getCurrentView()/Homey.error(), which don't exist on every pairing
    // client and crash the view — see pair/login_credentials.html), so the
    // translations the template used to render have to be handed over here.
    session.setHandler('get_login_texts', async () => ({
      texts: {
        title: this.homey.__('pair.title'),
        hostLabel: this.homey.__('pair.host_label'),
        hostPlaceholder: 'tplinkdeco.net',
        hostHint: this.homey.__('pair.host_hint'),
        passwordLabel: this.homey.__('pair.password_label'),
        passwordHint: this.homey.__('pair.password_hint'),
        loginButton: this.homey.__('pair.login_button'),
      },
      hostname,
    }));

    // Backend fallback for frontend navigation: the pairing view calls
    // Homey.showView() when that method exists on the client and falls back to
    // emitting 'goto_view' when it doesn't. Never let a navigation failure
    // reject — the frontend treats navigation as best-effort and keeps its own
    // status message on screen if it doesn't land.
    session.setHandler('goto_view', async (viewId: string) => {
      try {
        await session.showView(viewId);
        return true;
      } catch (navError: any) {
        this.error(`pair: session.showView(${viewId}) failed`, navError);
        return false;
      }
    });

    session.setHandler(
      'login',
      async (data: { username: string; password: string }) => {
        this.log('pair: login');
        hostname = this.normalizeHostname(data.username);
        this.log('hostname: ', hostname);
        password = data.password;
        this.log('password: [redacted]');
        this.log('creating client');
        lastLoginTrace = [];
        await this.logNetworkDiagnostics(hostname);
        // Use the same shared instance + auth queue as already-paired devices for this
        // hostname (see getOrCreateSharedApi/sharedAuthenticate above). A fresh, isolated
        // decoapiwrapper here would compete with sibling mesh nodes' ongoing polling for
        // the router's single admin session slot — and since that polling keeps renewing
        // its own session indefinitely, a competing login would never succeed no matter
        // how long the backoff is. Sharing the instance means there's only ever one login
        // in flight for this hostname, app-wide.
        this.api = this.getOrCreateSharedApi(hostname, this.makeLogger());

        // The router only allows one active admin session. Re-pairing right after
        // deleting the old devices can hit the previous session before it has timed
        // out on the router side (the app never sends an explicit logout), which
        // surfaces as a 403 → "RETRY:" error. That is not an unrecognised login
        // protocol, so retry with an escalating backoff before giving up — some
        // routers (e.g. reports from Homey Pro mini / homey6q) need longer than a
        // flat few seconds to release the stale session.
        const maxAttempts = SESSION_LIMIT_RETRY_BACKOFF_MS.length + 1;
        const pairingRetryStart = Date.now();
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await this.sharedAuthenticate(hostname, password, this.makeLogger());
            this.log('Successfully connected to TP-Link Deco');
            // Navigate explicitly rather than relying on a declarative
            // navigation.next on this step (see v1.4.51) — but kept OUTSIDE
            // the error-handling logic below: a PairSession.showView() failure
            // (e.g. the pairing UI already moved on) is not an auth error and
            // must never be miscategorised as one. Mis-categorising it here
            // previously fell into the "unknown protocol" branch below, which
            // tried session.showView('login_failed') on the same broken
            // session — an unhandled rejection that crashed the app silently
            // (homey-log's own crash-report path has an unrelated bug that
            // swallows the resulting error, so nothing showed up anywhere).
            // Login already succeeded at this point, so a navigation hiccup
            // is logged and ignored rather than failing the whole pairing.
            // Navigation is the frontend's job now (see pair/login_credentials.html):
            // it decides where to go from this return value. The backend no longer
            // calls session.showView() on the success path at all, so a navigation
            // hiccup can't be mistaken for an auth failure the way it used to be.
            return { ok: true, view: 'list_devices' };
          } catch (error: any) {
            const msg: string = error?.message ?? '';
            lastLoginTrace = (error as any)?.loginTrace ?? [];

            if (msg.startsWith('NETWORK:')) {
              this.error('pair: network error:', msg);
              throw new Error(msg.replace('NETWORK: ', ''));
            }
            if (msg.startsWith('CREDENTIALS:')) {
              this.error('pair: credentials error:', msg);
              throw new Error(msg.replace('CREDENTIALS: ', ''));
            }
            // The router has temporarily locked the account after too many failed
            // logins (error_code -5003, attemptsAllowed: 0). Retrying is actively
            // harmful here: every further attempt refreshes the lockout window, so
            // a user who keeps pressing Log in can never get back in. Stop
            // immediately and tell them to wait instead.
            if (msg.startsWith('LOCKED:')) {
              this.error('pair: router has locked the account after repeated failed logins:', msg);
              throw new Error(msg.replace('LOCKED: ', ''));
            }
            if (msg.startsWith('RETRY:')) {
              const delayMs = SESSION_LIMIT_RETRY_BACKOFF_MS[attempt - 1];
              const elapsed = Date.now() - pairingRetryStart;
              if (attempt < maxAttempts && elapsed + delayMs < PAIRING_RETRY_DEADLINE_MS) {
                this.log(`pair: login rejected (router session limit) — retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
              }
              this.error(`pair: login still rejected after retries (or over the ${PAIRING_RETRY_DEADLINE_MS / 1000}s pairing time budget) — a previous session is likely still active on the router:`, msg);
              (this.homey.app as any).reportIssue?.(
                `Pairing: router session limit not released after ${maxAttempts} retries (hostname=${hostname})`,
                { hostname, loginTrace: lastLoginTrace },
              );
              throw new Error('The router turned the login down. This usually clears on its own: wait about 15 minutes without pressing Log in, then try once more. If the Deco app or its web admin page is open on a phone or browser, close it first — the Deco only allows one admin session at a time.');
            }
            // Unknown protocol — all formats tried. The frontend navigates to the
            // diagnostic view based on this return value.
            this.error('pair: login failed — all formats exhausted. Trace:', JSON.stringify(lastLoginTrace));
            (this.homey.app as any).reportIssue?.(
              `Pairing: unrecognised login protocol (hostname=${hostname})`,
              { hostname, loginTrace: lastLoginTrace },
            );
            return { ok: false, view: 'login_failed' };
          }
        }
        return { ok: false, view: 'login_failed' };
      },
    );

    session.setHandler('get_diagnostic', async () => {
      return { trace: lastLoginTrace };
    });

    // Fired when the user fills in model/firmware on the login_failed view and copies
    // the debug report — forwards the same details to Sentry so unsupported firmware
    // is visible even when the user doesn't get around to opening a GitHub issue.
    session.setHandler('report_diagnostic', async (data: { model: string; firmware: string }) => {
      (this.homey.app as any).reportIssue?.(
        `Pairing: unrecognised login protocol — ${data?.model || 'unknown model'} fw ${data?.firmware || 'unknown'} (hostname=${hostname})`,
        { hostname, model: data?.model, firmware: data?.firmware, loginTrace: lastLoginTrace },
      );
      return true;
    });

    session.setHandler('goto_login', async () => {
      await session.showView('login_credentials');
      return true;
    });

    session.setHandler('list_devices', async () => {
      this.log('pair: list_devices');
      if (!this.api) {
        this.error('No API instance available');
        return [];
      }
      try {
        const deviceList = await this.safeApiCall(
          () =>
            this.api.custom(
              '/admin/device',
              { form: 'device_list' },
              this.readBody,
            ),
          {
            error_code: 1,
            result: {
              device_list: [
                {
                  bssid_2g: '',
                  bssid_5g: '',
                  bssid_sta_2g: '',
                  bssid_sta_5g: '',
                  device_ip: '',
                  device_model: '',
                  device_type: '',
                  group_status: '',
                  hardware_ver: '',
                  hw_id: '',
                  inet_error_msg: '',
                  inet_status: '',
                  mac: '',
                  nand_flash: true,
                  nickname: '',
                  oem_id: '',
                  oversized_firmware: false,
                  product_level: 0,
                  role: '',
                  set_gateway_support: true,
                  signal_level: {
                    band2_4: '',
                    band5: '',
                  },
                  software_ver: '',
                  support_plc: false,
                },
              ],
            },
          },
          'Device Data',
        );
        //const deviceList = (await this.api.deviceList()) as DeviceListResponse;
        if (
          deviceList.error_code === 0 &&
          deviceList.result.device_list.length > 0
        ) {
          // Use the master node's actual IP as the API endpoint for all devices.
          // This avoids relying on DNS (tplinkdeco.net) which can be unreliable,
          // and ensures we always connect through the master regardless of which
          // node the user typed.
          const masterDevice = deviceList.result.device_list.find(
            (d) => d.role?.toLowerCase() === 'master',
          );
          const apiHostname = masterDevice?.device_ip || hostname;
          this.log('pair: using API hostname:', apiHostname);

          const devices = deviceList.result.device_list
            // A node with no MAC cannot be added at all: `data.id` is the key
            // Homey stores the device under, so an undefined one fails
            // add_devices and two of them would collide with each other. The
            // settings coercion below does not help with that, because it is
            // `data`, not `settings`, that must be valid. Drop such nodes and
            // pair the rest rather than failing the whole mesh.
            .filter((device) => {
              if (device.mac) return true;
              this.error('pair: skipping a node the router reported without a MAC address');
              return false;
            })
            .map((device) => {
            const nickname = this.cleanString(this.resolveNickname(device));
            // Guard the model too. The report that prompted all this had a node
            // missing four fields; concatenating an absent device_model would
            // put the literal text "undefined" in the device's name.
            const model = device.device_model ?? 'Deco';
            const deviceName = model + (nickname ? ' - ' + nickname : '');
            return {
            name: deviceName,
            data: {
              id: device.mac,
            },
            // Every value here must be a defined string. A diagnostic log
            // (2026-09-01, BE85 mesh) showed the router returning a slave node
            // with device_ip/hardware_ver/software_ver/hw_id all absent, which
            // put literal `undefined` into these settings. Homey's add_devices
            // step cannot store an undefined setting value: the pairing session
            // died there and the whole app process restarted a moment later —
            // visible in that log as a fresh "App … started" line right after
            // `View: add_devices`, and in several other reports as two separate
            // node PIDs in one diagnostic. That is a second, independent cause
            // of "pairing bounces back with no error", unrelated to the login
            // template crash, and it only shows up on meshes where at least one
            // node reports incomplete data. Coerce everything to a safe string;
            // the real values get filled in by the device's first poll anyway.
            settings: {
              name: deviceName,
              mac: device.mac ?? '',
              hostname: apiHostname,
              password: password,
              model: model,
              ip: device.device_ip ?? '',
              role: device.role ?? '',
              hardware_ver: device.hardware_ver ?? '',
              software_ver: device.software_ver ?? '',
              hw_id: device.hw_id ?? '',
              timeoutSeconds: 30,
            },
          };
          });
          // Never log `devices` directly — settings.password holds the user's
          // real router password, and app logs end up verbatim in the
          // diagnostic reports users send us. Two such reports arrived with
          // the password in clear text before this was caught. Redact once and
          // use the redacted copy for every log line below.
          const redactedDevices = devices.map((d) => ({
            ...d,
            settings: { ...d.settings, password: '[redacted]' },
          }));
          this.log(redactedDevices);
          if (this.debugEnabled) {
            this.homey.app.log(
              `driver.ts: pair list_devices: `,
              JSON.stringify(redactedDevices, null, 2),
            );
          }
          return devices;
        } else {
          this.error('Failed to retrieve device information');
          return [];
        }
      } catch (error) {
        // Must return an array here — the built-in list_devices pairing template
        // reads .length on whatever this handler returns, so an implicit
        // `undefined` return (the previous behaviour) crashes the pairing UI
        // with "cannot read properties of null (reading 'length')" instead of
        // showing an empty list / error.
        this.error('Failed to retrieve device information', error);
        return [];
      }
    });
  }
  async onRepair(session: any): Promise<void> {
    this.log('Repair process initiated');
    let hostname = '';
    let password = '';

    // Kontrollera att session är korrekt
    if (!session) {
      this.error('No session provided for repair');
      return;
    }

    this.log('Setting up session handler for repair');
    // The whole PairSession object used to be serialised here. It told us
    // nothing useful, and app logs are copied verbatim into the diagnostic
    // reports users send in, so dumping an arbitrary SDK object into them is a
    // standing risk for no benefit.

    session.setHandler(
      'repair',
      async (data: { username: string; password: string }) => {
        this.log('pair: repairing');
        try {
          hostname = this.normalizeHostname(data.username);
        } catch (e: any) {
          // Every other failure in this handler answers with {success, error};
          // a throw would reach the repair view as a different shape entirely.
          return { success: false, error: e?.message ?? 'Invalid address.' };
        }
        this.log('hostname: ', hostname);
        password = data.password;
        this.log('password: [redacted]');
        this.log('repairing client');

        // See onPair's login handler for why this shares the driver-wide
        // sharedAuthenticate/getOrCreateSharedApi instead of a fresh instance,
        // and for why RETRY: needs its own retry/branch.
        const maxAttempts = SESSION_LIMIT_RETRY_BACKOFF_MS.length + 1;
        const repairRetryStart = Date.now();
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await this.sharedAuthenticate(hostname, password, this.makeLogger());
            this.log('Successfully connected to TP-Link Deco');
            return { success: true };
          } catch (error: any) {
            const msg: string = error?.message ?? '';
            this.error('pair: repair error:', msg);
            if (msg.startsWith('NETWORK:') || msg.startsWith('CREDENTIALS:')) {
              return { success: false, error: msg.replace(/^(NETWORK|CREDENTIALS): /, '') };
            }
            // Same as onPair: a locked account must not be retried, and must not
            // be reported as a wrong password — that invites the retry that
            // extends the lockout.
            if (msg.startsWith('LOCKED:')) {
              return { success: false, error: msg.replace('LOCKED: ', '') };
            }
            if (msg.startsWith('RETRY:')) {
              const delayMs = SESSION_LIMIT_RETRY_BACKOFF_MS[attempt - 1];
              const elapsed = Date.now() - repairRetryStart;
              if (attempt < maxAttempts && elapsed + delayMs < PAIRING_RETRY_DEADLINE_MS) {
                this.log(`pair: repair login rejected (router session limit) — retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
              }
              return { success: false, error: 'The router turned the login down. This usually clears on its own: wait about 15 minutes without trying again, then try once more. If the Deco app or its web admin page is open somewhere, close it first — the Deco only allows one admin session at a time.' };
            }
            return { success: false, error: 'Connection failed. Check the IP address and password.' };
          }
        }
        return { success: false, error: 'Connection failed. Check the IP address and password.' };
      },
    );
  }

  // Decodes a device nickname that may be base64-encoded or plain text.
  // Strategy: always attempt base64 decode, then validate the result.
  // If the decoded bytes produce invalid UTF-8 (\uFFFD) or control characters,
  // the input was plain text — return it unchanged.
  //
  // The old regex-based approach incorrectly flagged plain ASCII words whose
  // length is a multiple of 4 (e.g. "Zentrale") as base64, producing garbage
  // like "e❓❓❓❓^" when decoded.
  public decodeNickname(raw: string | undefined): string {
    if (!raw) return '';
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      // \uFFFD = UTF-8 replacement char inserted for invalid byte sequences.
      // \x00-\x1F = control chars that would never appear in a real device name.
      if (decoded.length > 0 && !/[\uFFFD\x00-\x1F]/.test(decoded)) {
        return decoded;
      }
    } catch {
      // not valid base64 at all
    }
    return raw;
  }

  // Resolves a human-readable nickname from a device list entry.
  // Newer firmware (e.g. P9) may store the display name in custom_nickname
  // while nickname is empty or contains a generic placeholder.
  public resolveNickname(device: { nickname?: string; custom_nickname?: string }): string {
    return this.decodeNickname(device.nickname) || this.decodeNickname(device.custom_nickname) || '';
  }

  private cleanString(input: string): string {
    // Regular expression to match escape characters and control characters.
    const escapeCharsRegex = /\\[\'\"\\nrtbfv0x0B\xFF]|[\x00-\x1F\x7F]/g;

    // Remove escape and control characters, and trim leading and trailing spaces in one step.
    return input.replace(escapeCharsRegex, '').trim();
  }

  private normalizeHostname(input: string): string {
    const host = input.trim().replace(/^https?:\/\//i, '').split('/')[0].trim();

    // An "@" makes this unusable as a host, and undici rejects it outright with
    // "Request cannot be constructed from a URL that includes credentials"
    // rather than anything a user could act on. A diagnostic log (2026-08-29)
    // showed exactly that: the user had typed their TP-Link account email into
    // the hostname field, and the app answered "Cannot reach router at
    // <their email>" — technically true, entirely unhelpful. The field asks for
    // a hostname or IP, but users arriving from the Deco app reasonably read
    // the login screen as asking for their account, so say plainly what is
    // wanted instead of letting the request fail deeper down.
    if (host.includes('@')) {
      throw new Error(
        'That looks like an email address. This field needs the address of your main Deco on your own network — usually 192.168.68.1, or tplinkdeco.net. You can check it by opening that address in a browser.',
      );
    }

    if (!host) {
      throw new Error(
        'Enter the address of your main Deco — usually 192.168.68.1, or tplinkdeco.net.',
      );
    }

    // Reject anything that cannot be a host before we spend a login attempt on
    // it. Users have typed an email address, their Wi-Fi network name (which
    // came back as the punycode failure "getaddrinfo ENOTFOUND xn--sjveian-r1a")
    // and Homey's own IP into this field — three different people reading a
    // box that wants an address plus a password as a request to sign in to
    // something. Each wrong guess used to travel all the way to a login POST,
    // and the router only allows ten failed logins before it locks the account,
    // so catching the obvious cases here protects the user's remaining
    // attempts. Deliberately permissive: only clearly-impossible hostnames are
    // refused, since a valid one may be an IP, a bare name, or an FQDN.
    const looksLikeHostOrIp = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host);
    if (!looksLikeHostOrIp) {
      throw new Error(
        `"${host}" is not an address this app can reach. Enter your main Deco's IP address (usually 192.168.68.1) or tplinkdeco.net — not your Wi-Fi network name or your TP-Link account.`,
      );
    }

    return host;
  }

  /**
   * Safely calls an API method and returns a default value if it fails.
   * @param apiMethod - The API method to call.
   * @param defaultValue - The default value to return in case of failure.
   * @param methodName - The name of the API method for logging purposes.
   * @returns The result of the API method or the default value.
   */
  private async safeApiCall<T>(
    apiMethod: () => Promise<T>,
    defaultValue: T,
    methodName: string = 'API method',
  ): Promise<T> {
    try {
      return await apiMethod();
    } catch (e) {
      this.error(`Failed to retrieve ${methodName}`, e);
      return defaultValue;
    }
  }
}

export { TplinkDecoDriver };
module.exports = TplinkDecoDriver;
