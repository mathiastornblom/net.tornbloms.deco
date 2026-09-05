import crypto from 'crypto';
import { Device } from 'homey';
import decoapiwrapper, { AppLogger } from '../../lib/client';
// Type-only import to access the driver's shared-auth methods without a circular dep
type TplinkDecoDriver = import('./driver').TplinkDecoDriver;
import {
  DeviceListResponse,
  PerformanceResponse,
  WANResponse,
  ClientListResponse,
  InternetResponse,
  ErrorResponse,
  LteIntfCfgResponse,
  LteLinkCfgResponse,
} from '../../lib/client';

// How long to retain a client in the tracked list without being seen (30 days)
const TRACKED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Mesh-wide "left" events are debounced by this many consecutive missed master polls
// (≈60s at the default 30s interval) to absorb the brief gap that can occur while a
// client re-associates with a different node during normal roaming.
const MESH_LEFT_GRACE_POLLS = 2;

// Per-node "offline" is debounced by this many consecutive polls without the
// client, for the same reason as MESH_LEFT_GRACE_POLLS above — see
// handleClientStateChanges().
const NODE_OFFLINE_GRACE_POLLS = 2;

// Lowest poll interval the app will use, matching the setting's minimum.
// Applied on load as well, so devices paired under the old 1s floor are raised.
const MIN_POLL_SECONDS = 15;

// Re-authentication backoff after a failed login: 30s doubling to a 10 minute
// ceiling. See reAuthenticate()/scheduleReAuthBackoff() for why an unbounded
// retry loop is worse than being slow to recover.
const REAUTH_BACKOFF_BASE_MS = 30 * 1000;
const REAUTH_BACKOFF_MAX_MS = 10 * 60 * 1000;

/**
 * Returns a deep copy of `value` with anything password-shaped replaced.
 *
 * This is deliberately central rather than per-call-site. Two diagnostic
 * reports users sent in contained their router password in clear text, from a
 * log line that serialised a settings object — and `debug('Settings:', ...)`
 * did exactly the same thing. App logs are copied verbatim into the diagnostic
 * reports users send us, so a single unredacted line anywhere is enough to leak
 * a credential. Making the debug helper itself incapable of printing one is a
 * stronger guarantee than remembering to redact at each call.
 */
function redactSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = /password|passwd|secret|token/i.test(key) ? '[redacted]' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

export interface TrackedClient {
  mac: string;
  name: string;       // decoded (human-readable)
  ip: string;
  type: string;
  online: boolean;    // currently online on this Deco node
  lastSeen: number;   // unix ms — last time seen online
  firstSeen: number;  // unix ms — first time seen
  access_host?: string; // MAC of the Deco node this client is connected to
}

export interface MeshTrackedClient extends TrackedClient {
  missedPolls: number; // consecutive master polls without seeing this client anywhere in the mesh
}

/**
 * Class representing a TP-Link Deco Device in Homey.
 * Manages initialization, settings updates, and device-specific actions.
 */
class TplinkDecoDevice extends Device {
  // Indicates if debug mode is enabled
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;

  // Variables to store previous state values
  private savedCpuUsage = 0;
  private savedMemUsage = 0;
  private savedWanipv4State = false;
  private savedWanipv6State = false;

  // Interval ID for periodic updates
  private timeoutSecondsIntervalId: ReturnType<typeof setInterval> | null =
    null;
  // One-shot timer IDs — cancelled in onDeleted to avoid post-deletion callbacks
  private rebootTimerId: ReturnType<typeof setTimeout> | null = null;
  private startupDelayTimerId: ReturnType<typeof setTimeout> | null = null;
  // Offsets this device's first poll so mesh nodes don't all fire together.
  // Separate from startupDelayTimerId, which the init path owns.
  private pollStartTimerId: ReturnType<typeof setTimeout> | null = null;
  private api: decoapiwrapper | any;

  connected = false; // Connection status
  clients: any[] = []; // Currently online clients (raw, for state comparison)

  // Re-authentication backoff state — consecutive failures, and the timestamp
  // before which reAuthenticate() refuses to try again.
  // Consecutive polls in which a client was missing from this node's client
  // list, keyed by MAC. Cleared as soon as the client shows up again.
  private nodeOfflineMisses = new Map<string, number>();

  // The role whose capability set has actually been applied. Kept in memory,
  // not in settings, so a failed apply is retried rather than recorded as done.
  private appliedRole = '';

  // Guards against overlapping poll cycles — see updateDeviceMetrics().
  private pollInFlight = false;

  private reAuthFailures = 0;
  private reAuthBlockedUntil = 0;

  // Persistent client history — all clients seen in the last 30 days.
  // Keyed by MAC address. Public so driver.ts can use it for autocomplete.
  trackedClients: Record<string, TrackedClient> = {};

  // Mesh-wide client history — only populated on the master node, sourced from the
  // driver's merged per-node client lists (see getMeshClientList). Public so driver.ts
  // can read it for the global mesh-presence flow cards.
  meshTrackedClients: Record<string, MeshTrackedClient> = {};

  // Buffer for read operations
  readBody = Buffer.from('{"operation": "read"}');

  // Cache for which cellular API form name works on this device.
  // undefined = not yet probed, null = confirmed not supported,
  // string = form prefix (e.g. 'lte', '5g', 'nr'); forms are <prefix>_intf_cfg / <prefix>_link_cfg.
  private lteFormCache: string | null | undefined = undefined;

  // Guards the one-time "Auth method: ... model=... fw=..." report so it only
  // fires once per device per app run, not on every poll cycle.
  private authMethodReported = false;

  // Returns a logger that routes through the Homey SDK so output appears
  // in diagnostics reports as well as the real-time developer tools.
  private makeLogger(): AppLogger {
    return {
      log: (...args: any[]) => this.log(...args),
      error: (...args: any[]) => this.error(...args),
    };
  }

  /**
   * Initializes the TP-Link Deco device.
   * Sets up the API connection using device settings and starts periodic updates.
   */
  async onInit() {
    try {
      // Log device initialization
      this.homey.app.log(
        `Device instance: ${this.getName()} (${this.getData().id})`,
      );
      this.log(`TP-Link Deco Device initialized: ${this.getName()}`);

      // Retrieve device data
      const devicedata = this.getData();

      // Load persistent client history from store
      this.trackedClients = (this.getStoreValue('trackedClients') as Record<string, TrackedClient>) ?? {};
      // Mesh-wide history is only ever written by the master node, but harmless to load on all
      this.meshTrackedClients = (this.getStoreValue('meshTrackedClients') as Record<string, MeshTrackedClient>) ?? {};

      // Retrieve device settings
      const settings = this.getSettings();
      this.debug(`Settings:`, settings);

      if (this.hasCapability('alarm_wan_ipv6_state')) {
        await this.removeCapability('alarm_wan_ipv6_state');
      }

      // Slave-only capabilities: only meaningful on satellite nodes.
      // Add for slaves, remove for master (avoids showing redundant "–" / "master" values).
      await this.applyRoleCapabilities(settings.role ?? '');
      this.appliedRole = (settings.role ?? '').trim();

      // Raising the setting's minimum only constrains what the UI will accept;
      // devices paired earlier keep whatever they stored. The users whose
      // networks this destabilised are on the old 10s default, so they would
      // have seen no change at all from the new floor. Clamp on load instead.
      if ((settings.timeoutSeconds ?? 0) < MIN_POLL_SECONDS) {
        this.log(`Poll interval ${settings.timeoutSeconds}s is below the ${MIN_POLL_SECONDS}s minimum — raising it`);
        await this.setSettings({ timeoutSeconds: MIN_POLL_SECONDS }).catch((e) =>
          this.error('Failed to raise poll interval to the minimum', e),
        );
        settings.timeoutSeconds = MIN_POLL_SECONDS;
      }

      // Check if hostname and password are provided
      if (settings.hostname && settings.password) {
        // Use the driver's shared API instance for this hostname.
        // All device instances on the same master share ONE session —
        // the Deco only allows one active login at a time.
        const driver = this.driver as TplinkDecoDriver;
        this.api = driver.getOrCreateSharedApi(settings.hostname, this.makeLogger());

        // Restore the previously-detected content-type preference so the first
        // auth attempt on restart already uses the known-good encoding rather
        // than retrying via auto-detect every time. Must apply unconditionally —
        // an explicitly cached `false` (this device needs form-urlencoded) used
        // to be silently dropped here, since the old code only ever set `true`
        // and otherwise left HttpClient's class default in place. That was
        // harmless while the default was also `false`, but stopped being safe
        // once the default flipped to `true` (see http.ts).
        const savedForceJson = (this.getStoreValue('forceJsonContentType') as boolean) ?? this.api.c.forceJsonContentType;
        this.api.c.forceJsonContentType = savedForceJson;
        // Restore the body format alongside the content type. Only half the
        // combo was ever persisted, so on every restart the other half fell back
        // to the class default and the login had to re-detect it — spending real
        // login attempts against a router that only allows ten before it locks
        // the account. Both halves are cached now, so a known-good combo is
        // tried first and usually succeeds on attempt one.
        const savedForceJsonBody = (this.getStoreValue('forceJsonBody') as boolean) ?? this.api.c.forceJsonBody;
        this.api.c.forceJsonBody = savedForceJsonBody;
        this.log(`Restored login format: ${savedForceJson ? 'application/json' : 'application/x-www-form-urlencoded'} / body ${savedForceJsonBody ? 'json' : 'form'} (from store)`);

        // Authentication is deliberately NOT awaited here — it happens inside the
        // staggered startup timer below, right before the first poll. onInit()
        // must return quickly regardless of router/network conditions: awaiting
        // a slow or unreachable router here (the auth retry chain can take well
        // over 30s — content-type negotiation, password-format fallback, session
        // limit backoff) risks the device/app missing Homey's startup ready
        // window, surfacing as "Unable to initialize app Error: ready_timeout"
        // (seen in the field on the Live channel).

        // Register capability listeners for reboot, CPU usage, and memory usage
        this.registerCapabilityListener('reboot', async (value) => {
          if (Boolean(value)) {
            this.log(`Reboot triggered: ${Boolean(value)}`);
            this.log(`mac: ${devicedata.id}`);
            const rebooted = await this.api
              .reboot(devicedata.id)
              .catch(this.error);
            if (rebooted) {
              await this.setUnavailable(
                this.homey.__('flow.reboot_deco.message'),
              );
              this.rebootTimerId = setTimeout(async () => {
                this.rebootTimerId = null;
                try {
                  await this.setAvailable();
                  await this.setCapabilityValue('reboot', false).catch(this.error);
                } catch (e: any) {
                  this.log('Reboot timer: device already gone, skipping setAvailable', e?.message);
                }
              }, 60000); // 60 seconds
            } else {
              this.error('Failed to reboot');
            }
          }
        });

        // Pause/resume polling — lets users stop API calls entirely (e.g. while
        // troubleshooting a router session conflict, or to reduce load on
        // routers that struggle with sustained polling) without deleting the
        // device. Mirrors the pause/resume control other Deco integrations
        // (e.g. Home Assistant's) expose for the same reason.
        //
        // The capability is "active" rather than "paused" so the toggle's lit/on
        // state always means "running" — a lit toggle meaning "paused" reads
        // backwards to users (reported feedback after the first version of this
        // shipped as polling_paused).
        if (this.hasCapability('polling_active') && this.getCapabilityValue('polling_active') === null) {
          await this.setCapabilityValue('polling_active', true).catch(this.error);
        }
        this.registerCapabilityListener('polling_active', async (value) => {
          const active = Boolean(value);
          this.log(`Polling ${active ? 'resumed' : 'paused'} by user`);
          if (!active) {
            if (this.startupDelayTimerId) {
              clearTimeout(this.startupDelayTimerId);
              this.startupDelayTimerId = null;
            }
            // Also cancel a pending first-poll offset. That window is now up to
            // a full interval, so pausing during it used to leave a timer that
            // went on to poll once and then install a fresh interval — the
            // toggle said "paused" while the router kept being polled.
            if (this.pollStartTimerId) {
              clearTimeout(this.pollStartTimerId);
              this.pollStartTimerId = null;
            }
            if (this.timeoutSecondsIntervalId) {
              clearInterval(this.timeoutSecondsIntervalId);
              this.timeoutSecondsIntervalId = null;
            }
          } else {
            const resumedInterval = (this.getSettings().timeoutSeconds || 30) * 1000;
            try {
              await this.updateDeviceMetrics();
            } catch (e: any) {
              this.error('Resume poll failed', e);
            }
            this.setUpdateInterval(resumedInterval);
          }
        });

        const clientStateFlow = this.homey.flow.getDeviceTriggerCard(
          'client_state_changed',
        );
        clientStateFlow.registerRunListener(async (args, state) => {
          return (
            args.status === state.status && args.client.mac === state.client.mac
          );
        });

        // any_client_state_changed — fires for every state change, filtered only by status
        const anyClientStateFlow = this.homey.flow.getDeviceTriggerCard('any_client_state_changed');
        anyClientStateFlow.registerRunListener(async (args, state) => {
          return args.status === state.status;
        });

        // client_node_changed — fires when a specific client roams to a different Deco node
        const clientNodeChangedFlow = this.homey.flow.getDeviceTriggerCard('client_node_changed');
        clientNodeChangedFlow.registerRunListener(async (args, state) => {
          return args.client.mac === state.mac;
        });
        clientNodeChangedFlow.registerArgumentAutocompleteListener(
          'client',
          async (query, args) => {
            const driver = this.driver as TplinkDecoDriver;
            return driver.buildClientAutocomplete(this, query);
          },
        );

        if (this.getCapabilityValue('polling_active') === false) {
          this.log('Polling paused (restored from saved state) — skipping startup poll');
          return;
        }

        // Stagger first poll across devices to avoid simultaneous auth attempts.
        // The Deco allows only one session at a time — concurrent logins cause
        // HTTP 403 on all-but-one device. A random 0–15 s delay spreads them out.
        const interval = (settings.timeoutSeconds || 30) * 1000;
        const startupDelay = Math.floor(Math.random() * Math.min(interval, 15000));
        this.log(`First poll in ${startupDelay / 1000}s (stagger offset)`);
        this.startupDelayTimerId = setTimeout(async () => {
          this.startupDelayTimerId = null;
          try {
            if (!this.connected) {
              await this.reAuthenticate();
            }
            await this.updateDeviceMetrics();
            this.setUpdateInterval(interval);
          } catch (e: any) {
            this.log('Startup delay timer: device already gone, skipping', e?.message);
          }
        }, startupDelay);
      } else {
        this.error('Missing API configuration settings');
      }
    } catch (error) {
      this.error('Failed to initialize device', error);
    }
  }

  /**
   * Handles updates to the device settings.
   * Reinitializes the API connection if relevant settings are changed.
   * @param oldSettings - The old settings before the change.
   * @param newSettings - The new settings after the change.
   * @param changedKeys - The keys that were changed.
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: any };
    newSettings: { [key: string]: any };
    changedKeys: string[];
  }): Promise<void> {
    this.log('Device settings updated:', changedKeys);

    // Update debug mode if changed
    if (changedKeys.includes('debugenabled')) {
      this.debugEnabled = newSettings.debugenabled === 'true';
    }

    // Reinitialize API if hostname or password has changed
    if (changedKeys.includes('hostname') || changedKeys.includes('password')) {
      try {
        const driver = this.driver as TplinkDecoDriver;
        this.api = driver.getOrCreateSharedApi(newSettings.hostname, this.makeLogger());
        // Clear the stored content-type preference for new credentials — authenticate()
        // tries every contentType/bodyFormat/passwordMode combo regardless of where
        // forceJsonContentType currently sits, so there's no "common case" to bias
        // toward here; just drop the stale preference and let it re-detect.
        await this.unsetStoreValue('forceJsonContentType');
        await this.unsetStoreValue('forceJsonBody');
        this.connected = await driver.sharedAuthenticate(newSettings.hostname, newSettings.password, this.makeLogger());
        if (this.connected) {
          await this.setStoreValue('forceJsonContentType', this.api.c.forceJsonContentType);
          await this.setStoreValue('forceJsonBody', this.api.c.forceJsonBody);
        }
        this.log('API reinitialized with updated settings');
      } catch (error) {
        this.error('Failed to reinitialize API', error);
      }
    }

    // Update the interval if timeoutSeconds has changed (skip while paused —
    // the interval stays cleared until the user resumes via polling_active)
    if (changedKeys.includes('timeoutSeconds') && this.getCapabilityValue('polling_active') !== false) {
      const interval = (newSettings.timeoutSeconds || 15) * 1000; // Default to 15 seconds if not set
      this.setUpdateInterval(interval);
      this.log(
        `Update interval changed to ${newSettings.timeoutSeconds} seconds`,
      );
    }
  }

  /**
   * Called when the app shuts down.
   *
   * onDeleted only fires when the user removes a device, so before this every
   * poll interval and pending timer survived app shutdown and kept firing
   * against a destroyed app instance. That is the "not cleaning up all
   * resources in onUninit()" the SDK names in the crash report we received from
   * a Homey (Early 2019).
   */
  async onUninit(): Promise<void> {
    this.log('TplinkDecoDevice unloading — clearing timers');
    if (this.rebootTimerId) {
      clearTimeout(this.rebootTimerId);
      this.rebootTimerId = null;
    }
    if (this.startupDelayTimerId) {
      clearTimeout(this.startupDelayTimerId);
      this.startupDelayTimerId = null;
    }
    if (this.pollStartTimerId) {
      clearTimeout(this.pollStartTimerId);
      this.pollStartTimerId = null;
    }
    if (this.timeoutSecondsIntervalId) {
      clearInterval(this.timeoutSecondsIntervalId);
      this.timeoutSecondsIntervalId = null;
    }
  }

  /**
   * Called when the device is deleted.
   * Ensures that any active intervals are cleared to prevent continued operations.
   */
  async onDeleted(): Promise<void> {
    this.log('TplinkDecoDevice has been deleted');

    if (this.rebootTimerId) {
      clearTimeout(this.rebootTimerId);
      this.rebootTimerId = null;
    }
    if (this.startupDelayTimerId) {
      clearTimeout(this.startupDelayTimerId);
      this.startupDelayTimerId = null;
    }
    if (this.pollStartTimerId) {
      clearTimeout(this.pollStartTimerId);
      this.pollStartTimerId = null;
    }
    if (this.timeoutSecondsIntervalId) {
      clearInterval(this.timeoutSecondsIntervalId);
      this.log('Cleared interval for device metrics update');
      this.timeoutSecondsIntervalId = null;
    }
  }

  /**
   * Sets up or updates the interval for updating device metrics.
   * @param interval - The interval in milliseconds.
   */
  private setUpdateInterval(interval: number) {
    // Clear any existing interval and any pending first-poll offset
    if (this.timeoutSecondsIntervalId) {
      clearInterval(this.timeoutSecondsIntervalId);
      this.timeoutSecondsIntervalId = null;
    }
    if (this.pollStartTimerId) {
      clearTimeout(this.pollStartTimerId);
      this.pollStartTimerId = null;
    }

    // Spread each node's polls across the whole interval rather than nudging
    // them a few seconds apart.
    //
    // Three users have reported the app destabilising their network — one
    // A/B-tested it over several days on a three-node XE75 Pro mesh (internet
    // solid with the app off, down within half an hour of switching it back on),
    // another saw an X60 mesh drop for ~5 minutes at a time and fixed it by
    // raising the interval from 10s to 30s. Both were running every node's poll
    // within a 5-second window of each other, so the router took the whole
    // mesh's worth of API calls in one burst each cycle. A jitter window equal
    // to the interval turns that burst into a steady trickle at the same total
    // rate. The first poll is offset too, so a restart doesn't line every device
    // up again.
    const jitter = Math.random() * interval;
    if (this.pollStartTimerId) clearTimeout(this.pollStartTimerId);
    this.pollStartTimerId = setTimeout(() => {
      this.pollStartTimerId = null;
      this.updateDeviceMetrics();
      this.timeoutSecondsIntervalId = setInterval(
        this.updateDeviceMetrics.bind(this),
        interval,
      );
    }, jitter);
    this.log(`Set update interval to ${interval / 1000}s (first poll in ${Math.round(jitter / 1000)}s)`);
  }

  /**
   * Re-authenticates the API session when the STOK has expired.
   * Returns true if re-authentication succeeded.
   */
  private async reAuthenticate(): Promise<boolean> {
    // Back off after repeated failures instead of re-authenticating on every
    // single poll. Diagnostic reports showed what the old unconditional retry
    // did on a mesh whose nodes had stopped answering: five devices each ran
    // "session expired → authenticate → timeout → RSA key is missing → session
    // expired" continuously, with no pause anywhere in the loop. The router was
    // then permanently busy refusing logins, so nothing ever recovered, and the
    // app reported "Cannot reach router" for a network that was in fact fine.
    // The backoff caps at ~10 minutes; any success resets it immediately.
    const now = Date.now();
    if (now < this.reAuthBlockedUntil) {
      const waitSeconds = Math.ceil((this.reAuthBlockedUntil - now) / 1000);
      this.log(`Skipping re-authentication — backing off for another ${waitSeconds}s after ${this.reAuthFailures} failed attempt(s)`);
      return false;
    }

    try {
      const settings = this.getSettings();

      // Guard against an empty/missing hostname. A diagnostic log showed the app
      // trying to reach the literal host "null" and telling the user "Cannot
      // reach router at null" — a message that can only confuse. Without a
      // hostname there is nothing to retry, so fail visibly instead.
      const host = (settings.hostname ?? '').trim();
      if (!host) {
        this.error('Cannot re-authenticate: no hostname is set on this device');
        await this.markUnavailable('This device has no router address set. Remove it and add it again.');
        this.scheduleReAuthBackoff();
        return false;
      }

      this.log('Session expired, re-authenticating...');
      const driver = this.driver as TplinkDecoDriver;
      // Use the shared serialised auth — if another device is already
      // authenticating, we wait for the same result instead of racing.
      this.connected = await driver.sharedAuthenticate(
        host,
        settings.password,
        this.makeLogger(),
      );
      if (this.connected) {
        // Persist the content-type preference that worked so restarts skip re-detection.
        await this.setStoreValue('forceJsonContentType', this.api.c.forceJsonContentType);
        await this.setStoreValue('forceJsonBody', this.api.c.forceJsonBody);
        this.log('Re-authentication successful');
        this.reAuthFailures = 0;
        this.reAuthBlockedUntil = 0;
        await this.markAvailable();
      } else {
        this.error('Re-authentication failed');
        this.scheduleReAuthBackoff();
      }
      return this.connected;
    } catch (e) {
      this.error('Re-authentication error', e);
      // authenticate() signals failure by throwing, never by returning false, so
      // without this the flag kept its previous value. On the common case — a
      // device that was working and whose router then stopped answering —
      // `connected` stayed true, which made the "skip the poll while backing
      // off" guard in updateDeviceMetrics() never fire, and the full failing
      // cycle ran every interval anyway.
      this.connected = false;
      this.scheduleReAuthBackoff();
      return false;
    }
  }

  /**
   * Brings the capability set in line with this node's role.
   *
   * Slave-only capabilities (signal strength, backhaul) are meaningless on the
   * master; master-only ones (CPU, RAM, WAN) are never reported by satellites
   * and would otherwise sit there showing a stale or never-set value. This used
   * to live inline in onInit, which meant a node that changed role kept the
   * wrong capability set until the app was restarted.
   */
  private async applyRoleCapabilities(role: string): Promise<void> {
    const isMaster = role.toLowerCase() === 'master';
    for (const cap of ['signal_strength_2g', 'signal_strength_5g', 'backhaul_connection']) {
      if (isMaster && this.hasCapability(cap)) {
        await this.removeCapability(cap);
      } else if (!isMaster && !this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
    }
    // Master-only capabilities. This has to be symmetric: the removal branch
    // alone existed before, and only `wan_ipv4_ipaddr` was ever added back, so a
    // node promoted from satellite to master lost CPU, RAM and the WAN alarm
    // permanently — nothing else in the app adds them, and a restart did not
    // help because onInit runs this same function. It went unnoticed while this
    // logic only ran at init; making it react to a role change at runtime is
    // exactly what would have exposed it.
    for (const cap of ['measure_cpu_usage', 'measure_mem_usage', 'alarm_wan_ipv4_state', 'wan_ipv4_ipaddr']) {
      if (isMaster && !this.hasCapability(cap)) {
        await this.addCapability(cap);
      } else if (!isMaster && this.hasCapability(cap)) {
        await this.removeCapability(cap);
      }
    }
  }

  /**
   * Adopts the mesh's current master address and this node's current role from a
   * freshly fetched device list. See the call site for why this matters.
   *
   * Only writes when something actually changed, so the normal path costs one
   * comparison per poll and no settings write.
   */
  private async followMeshMaster(
    // Structurally typed rather than DeviceListResponse: the value the caller
    // has in hand comes back through safeApiCall's fallback shape, which is a
    // subset of the full response type. Only these fields are read.
    deviceList: { result?: { device_list?: Array<{ mac?: string; role?: string; device_ip?: string }> } },
  ): Promise<void> {
    try {
      const nodes = deviceList.result?.device_list ?? [];
      const self = nodes.find((d) => d.mac === this.getData().id);

      // Deliberately NOT rewriting `hostname` here.
      //
      // An earlier version of this adopted the master's IP whenever it differed
      // from the configured hostname. That is wrong for the majority of
      // installs: the pairing field's placeholder is `tplinkdeco.net`, so every
      // user who accepted it would have had their DNS name silently replaced by
      // a DHCP-assigned IP on the first poll after upgrading — with no way back
      // if that lease later changed, since this function only runs *after* a
      // successful device_list. It would also have created a second shared API
      // instance while the first kept an unclosed session, and different nodes
      // would have switched at different times, putting two logins on a router
      // that allows one. And for at least one reported mesh, login works on the
      // satellites but fails on the master, so "follow the master" would move
      // that user onto the address that does not work.
      //
      // Keeping the hostname the user chose is the safe behaviour. The stale
      // master/role display this was meant to fix is handled by the role and ip
      // updates below, which are display-only and carry none of that risk.
      const role = (self?.role ?? '').trim();
      if (!role) return;

      // Settings are deliberately not written here. The block further down this
      // same poll cycle already persists role/ip/hardware_ver/software_ver
      // unconditionally, so writing them here as well was redundant — and worse,
      // it made failure unrecoverable: if applyRoleCapabilities threw, the catch
      // below swallowed it while that later write still persisted the new role,
      // so the next poll saw no difference and the capability change was never
      // retried.
      //
      // Tracking the applied role in memory instead means a failure is retried
      // on the next poll, and a restart re-applies from onInit regardless.
      if (role === this.appliedRole) return;
      this.log(`Node role is now "${role}" — updating capabilities`);
      await this.applyRoleCapabilities(role);
      this.appliedRole = role;
    } catch (e) {
      // Never let bookkeeping break a poll cycle.
      this.error('followMeshMaster failed', e);
    }
  }

  /**
   * Marks the device unavailable in Homey with a reason the user can read.
   *
   * Without this, a device whose polling has failed keeps displaying whatever
   * it last managed to read. One user reported a Deco showing "WAN disconnected"
   * in Homey while the network was working perfectly — the app had simply stopped
   * being able to ask, and the last value it had happened to be an alarm. Stale
   * values that look authoritative are worse than an explicit "unavailable".
   */
  private async markUnavailable(reason: string): Promise<void> {
    try {
      if (this.getAvailable()) await this.setUnavailable(reason);
    } catch (e) {
      this.error('Failed to mark device unavailable', e);
    }
  }

  /** Clears the unavailable state set by markUnavailable(). */
  private async markAvailable(): Promise<void> {
    try {
      if (!this.getAvailable()) await this.setAvailable();
    } catch (e) {
      this.error('Failed to mark device available', e);
    }
  }

  /**
   * Grows the re-authentication backoff after a failure: 30s, 60s, 2m, 4m, 8m,
   * then a 10m ceiling. Deliberately generous — a Deco that is refusing logins
   * needs to be left alone to recover, and an idle app that retries a minute
   * late is far better than one that keeps a struggling router pinned.
   */
  private scheduleReAuthBackoff(): void {
    this.reAuthFailures += 1;
    // After a couple of consecutive failures this is no longer a blip. Say so,
    // rather than letting the last-known values stand in for live data.
    if (this.reAuthFailures >= 2) {
      void this.markUnavailable('Cannot reach the Deco. Retrying in the background.');
    }
    const delayMs = Math.min(
      REAUTH_BACKOFF_BASE_MS * 2 ** (this.reAuthFailures - 1),
      REAUTH_BACKOFF_MAX_MS,
    );
    this.reAuthBlockedUntil = Date.now() + delayMs;
    this.log(`Re-authentication failed ${this.reAuthFailures} time(s) — next attempt in ${Math.round(delayMs / 1000)}s`);
  }

  /**
   * Updates device metrics by fetching data from the API and updating capabilities.
   * Handles performance metrics, WAN IP address, internet status, client list, and client state changes.
   */
  private async updateDeviceMetrics() {
    // A poll can take longer than the interval on a slow mesh — the per-request
    // timeout alone is 15s against a 15s minimum interval — and nothing stopped
    // a second cycle starting while the first was still in flight. Overlapping
    // cycles double the load on a router this release is trying to relieve, and
    // two of them inside followMeshMaster can both pass hasCapability() before
    // either addCapability() resolves, which raises `capability_already_exists`
    // — the very error a user reported as making the app unable to start.
    if (this.pollInFlight) {
      this.log('Skipping poll — the previous one has not finished yet');
      return;
    }
    this.pollInFlight = true;
    try {
      // While the re-auth backoff is running there is no valid session, so every
      // API call in this method would fail the same way — most visibly as
      // "RSA key is missing or undefined", thrown by doEncryptedPost() because
      // the poll timer kept firing at full rate against a client that had no
      // key. Skip the whole cycle instead of generating a round of guaranteed
      // failures (and load on a router that is already struggling) every tick.
      if (!this.connected && Date.now() < this.reAuthBlockedUntil) {
        return;
      }

      const settings = this.getSettings();
      const devicedata = this.getData();

      // Retrieve device list from the API
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
      this.debug(`${settings.hostname} onInit():deviceList: `, deviceList);

      // If the API returns an error or device_list is missing (empty stok returns { error_code:0, result:{} }),
      // the session has expired or was never established — re-auth and wait for next poll
      if (deviceList.error_code !== 0 || !deviceList.result?.device_list) {
        await this.reAuthenticate();
        return;
      }

      if (deviceList.result.device_list.length > 0) {
        // Keep this device pointed at whichever node is currently master, and
        // keep its own recorded role honest.
        //
        // Three separate reports come back to this. One user swapped their main
        // Deco and Homey went on showing a satellite as master, with the wrong
        // client count and two nodes missing entirely — and asked, reasonably,
        // whether the existing devices could follow the new main unit without
        // being deleted and re-added, since that would cost them their Flows.
        // Another had every node authenticating against its own IP rather than
        // the master's, which defeats the shared session entirely and produced a
        // continuous re-auth storm. A third saw mesh-wide presence only ever
        // report clients on the master, which is what happens when satellites
        // file their client lists under a different hostname key than the one
        // the master reads back.
        //
        // The device list we just fetched already names the master, so adopt it.
        // The device's identity is its MAC, so following the master costs
        // nothing and no Flow is disturbed.
        await this.followMeshMaster(deviceList);

        // Filter the device list to find the current device
        const device = deviceList.result.device_list.find(
          (d) => d.mac === devicedata.id,
        );

        this.debug(`${settings.hostname} onInit():Filtered device: `, device);

        if (device) {
          // Report the settled auth method (Content-Type / body format / password
          // mode, all cached on this.api.c after the first successful login) paired
          // with this device's exact model/firmware. Building this up across users
          // in Sentry over time is the cheap alternative to asking for a fresh HAR
          // every time a new login quirk shows up — if a specific model/firmware
          // combo consistently needs unusual handling, this is how we'd notice
          // without already suspecting it. One report per device per app run.
          if (!this.authMethodReported) {
            this.authMethodReported = true;
            // Fixed message so every report dedupes into ONE Sentry issue —
            // reportIssue()/homey-log dedupes by exact message string, and a
            // per-model/firmware message here would instead spawn a brand new,
            // permanent issue for every device variant across all users (it did:
            // dozens of "Auth method: ..." issues appeared within minutes of
            // shipping this). The variant data goes in `extra` and is visible
            // per-event in Sentry without multiplying the issue list.
            (this.homey.app as any).reportIssue?.(
              'Auth method reported',
              {
                contentType: this.api.c.forceJsonContentType ? 'json' : 'urlencoded',
                bodyFormat: this.api.c.forceJsonBody ? 'json' : 'form',
                model: device.device_model,
                hardware_ver: device.hardware_ver,
                software_ver: device.software_ver,
              },
            );
          }

          // Update device settings with retrieved information
          await this.setSettings({
            hardware_ver: device.hardware_ver,
            software_ver: device.software_ver,
            role: device.role,
            ip: device.device_ip,
          });

          await this.updateCapability(
            'alarm_group_state',
            device.group_status.toLowerCase() !== 'connected',
          );
          await this.updateCapability('device_role', settings.role);
          await this.updateCapability('lan_ipv4_ipaddr', device.device_ip || settings.ip || settings.hostname);

          // Signal strength and backhaul are only meaningful on satellite nodes.
          // Dynamically add/remove so they never appear on the master tile.
          const isMaster = device.role.toLowerCase() === 'master';
          for (const cap of ['signal_strength_2g', 'signal_strength_5g', 'backhaul_connection']) {
            if (isMaster && this.hasCapability(cap)) {
              await this.removeCapability(cap);
            } else if (!isMaster && !this.hasCapability(cap)) {
              await this.addCapability(cap);
            }
          }

          if (!isMaster) {
            const signalLabel = (v: string | undefined) => {
              if (v === '1') return 'Weak';
              if (v === '2') return 'Good';
              if (v === '3') return 'Strong';
              return v || '–';
            };
            await this.updateCapability(
              'signal_strength_2g',
              signalLabel(device.signal_level?.band2_4),
            );
            await this.updateCapability(
              'signal_strength_5g',
              signalLabel(device.signal_level?.band5),
            );
            const connectionTypes: string[] | undefined = (device as any).connection_type;
            const backhaulLabel = (types: string[] | undefined) => {
              if (!Array.isArray(types) || types.length === 0) return '–';
              return types
                .map((t) => {
                  if (t === 'wired') return 'Wired';
                  if (t === 'band2_4') return 'WiFi 2.4 GHz';
                  if (t === 'band5') return 'WiFi 5 GHz';
                  if (t === 'band5_2') return 'WiFi 5 GHz (2)';
                  if (t === 'band6') return 'WiFi 6 GHz';
                  return t; // unknown — show raw so nothing is silently dropped
                })
                .join(' + ');
            };
            await this.updateCapability('backhaul_connection', backhaulLabel(connectionTypes));
          }

          // Fetch performance metrics — only available on master node
          let resultCpuUsage = 0;
          let resultMemUsage = 0;
          if (isMaster) {
            const performance = await this.safeApiCall(
              () =>
                this.api.custom(
                  '/admin/network',
                  { form: 'performance' },
                  this.readBody,
                ),
              {
                error_code: 1,
                result: { cpu_usage: 0, mem_usage: 0 },
              },
              'Performance Metrics',
            );
            resultCpuUsage = Math.round(Number(performance?.result?.cpu_usage ?? 0) * 100);
            resultMemUsage = Math.round(Number(performance?.result?.mem_usage ?? 0) * 100);
            await this.updateCapability('measure_cpu_usage', resultCpuUsage);
            await this.updateCapability('measure_mem_usage', resultMemUsage);
          }

          // Fetch WAN IP address
          if (device.role.toLowerCase() === 'master') {
            const wanResponse = await this.safeApiCall(
              () =>
                this.api.custom(
                  '/admin/network',
                  { form: 'wan_ipv4' },
                  this.readBody,
                ),
              {
                error_code: 1,
                result: {
                  lan: {
                    ip_info: {
                      ip: '',
                      mac: '',
                      mask: '',
                    },
                  },
                  wan: {
                    dial_type: '',
                    enable_auto_dns: '',
                    info: {},
                    ip_info: {
                      dns1: '',
                      dns2: '',
                      gateway: '',
                      ip: '',
                      mac: '',
                      mask: '',
                    },
                  },
                },
              },
              'WAN IPv4 Data',
            );

            // Extract WAN IP address
            const wanIpAddress = wanResponse?.result?.wan?.ip_info?.ip ?? '';
            // Update capability with WAN IP address
            await this.updateCapability('wan_ipv4_ipaddr', wanIpAddress);
          }
          // Fetch Internet status — only available on master node
          if (isMaster) {
            const internetResponse = await this.safeApiCall(
              () =>
                this.api.custom(
                  '/admin/network',
                  { form: 'internet' },
                  this.readBody,
                ),
              {
                error_code: 1,
                result: {
                  ipv4: {
                    auto_detect_type: '',
                    connect_type: '',
                    dial_status: '',
                    error_code: 1,
                    inet_status: '',
                  },
                  ipv6: {
                    auto_detect_type: '',
                    connect_type: '',
                    dial_status: '',
                    error_code: 1,
                    inet_status: '',
                  },
                  link_status: '',
                },
              },
              'Internet Status',
            );

            // Only update WAN alarm when we got a real response (not the safeApiCall fallback).
            // If the call failed/timed-out, error_code is 1 (our default) and we leave
            // the capability at its last known value to avoid false "disconnected" alerts.
            if (internetResponse?.error_code === 0) {
              // Cellular models (IMEI present, e.g. X50-5G) connect to the internet via
              // 5G — the wired WAN port is unused so internet.ipv4.inet_status is empty /
              // disconnected even when online.  device_list.inet_status is the reliable
              // source for actual internet connectivity on these models.
              const ipv4InetStatus = (device as any).imei
                ? device.inet_status
                : (internetResponse?.result?.ipv4?.inet_status ?? '');
              await this.handleWanStateChange(
                'ipv4',
                ipv4InetStatus,
                this.savedWanipv4State ?? false,
                'alarm_wan_ipv4_state',
              );
              if (internetResponse?.result?.ipv6?.error_code === 0) {
                if (!this.hasCapability('alarm_wan_ipv6_state')) {
                  await this.addCapability('alarm_wan_ipv6_state');
                }
                await this.handleWanStateChange(
                  'ipv6',
                  internetResponse?.result?.ipv6?.inet_status ?? '',
                  this.savedWanipv6State ?? false,
                  'alarm_wan_ipv6_state',
                );
              }
            }
          }

          // Fetch client list — use this device's MAC so each node only reports its own clients,
          // preventing duplicate flow triggers when multiple Deco units are paired.
          const request = {
            operation: 'read',
            params: {
              device_mac: devicedata.id,
            },
          };
          const jsonRequest = JSON.stringify(request);
          const clientListResponse = await this.safeApiCall(
            () =>
              this.api.custom(
                '/admin/client',
                { form: 'client_list' },
                Buffer.from(jsonRequest),
              ),
            {
              error_code: 0,
              result: {
                client_list: [
                  {
                    access_host: '',
                    client_mesh: true,
                    client_type: '',
                    connection_type: '',
                    down_speed: 0,
                    enable_priority: false,
                    interface: '',
                    ip: '',
                    mac: '',
                    name: '',
                    online: true,
                    owner_id: '',
                    remain_time: 0,
                    space_id: '',
                    up_speed: 0,
                    wire_type: '',
                  },
                ],
              },
            },
            'Client List',
          );
          // let clientListResponse = (await this.api.clientList().catch((e) => {
          //   this.error('Failed to retrieve client list', e);
          //   this.homey.app.error('Failed to retrieve client list', e);
          //   return {
          //     error_code: 1,
          //     result: {
          //       client_list: [],
          //     },
          //   }; // Return default values in case of error
          // })) as ClientListResponse;

          // Some Deco firmware returns client_list as {} instead of [] when
          // there are no connected clients. Use Array.isArray to handle all
          // non-array shapes (null, undefined, {}, 0, …).
          const rawClientList = clientListResponse?.result?.client_list;
          const clientList = Array.isArray(rawClientList) ? rawClientList : [];

          // Feed this node's own client list into the driver's shared cache so the
          // master can build a mesh-wide view without a separate API call (see
          // getMeshClientList below — replaces the old device_mac: 'default' request,
          // which returned error_code=1 across ~14 models in our field telemetry).
          if (devicedata.id) {
            (this.driver as TplinkDecoDriver).setNodeClientList(settings.hostname, devicedata.id, clientList);
          }

          const clientNames = clientList
            .map((client) => (this.driver as TplinkDecoDriver).decodeNickname(client.name))
            .join(', ');
          await this.setSettings({ clients: clientNames });
          // Update capability with the number of connected clients
          await this.updateCapability('connected_clients', clientList.length);

          // Build a MAC → friendly-name map for the Deco nodes so the
          // client_node_changed token shows a human-readable name.
          const decoNodeNames = new Map<string, string>();
          for (const d of deviceList.result.device_list) {
            if (d.mac) {
              const nick = (this.driver as TplinkDecoDriver).resolveNickname(d);
              decoNodeNames.set(d.mac.toUpperCase(), nick ? `${d.device_model} - ${nick}` : (d.device_model || d.mac));
            }
          }

          // Handle client state changes
          await this.handleClientStateChanges(clientList, decoNodeNames);

          // Mesh-wide presence — master only. Previously fetched via a dedicated
          // device_mac: 'default' request, which returned error_code=1 across a
          // dozen+ models in our field telemetry (other Deco integrations document
          // 'default' as supported, so this may be firmware/model-specific rather
          // than universally invalid — see TplinkDecoDriver.nodeClientLists for
          // details). Build the mesh-wide view instead from the per-node client
          // lists every device already fetches for itself above (device_mac: <own
          // MAC>, confirmed working everywhere) — no extra API call needed either way.
          if (isMaster) {
            const meshClientList = (this.driver as TplinkDecoDriver).getMeshClientList(settings.hostname);
            this.log(`Mesh-wide client snapshot: clients=${meshClientList.length} (merged from ${deviceList.result.device_list.length} node(s))`);
            await this.handleMeshPresence(meshClientList, decoNodeNames);
          }

          // Calculate total download and upload speeds
          const { totalDownKiloBytesPerSecond, totalUpKiloBytesPerSecond } =
            clientList.reduce(
              (totals, client) => {
                totals.totalDownKiloBytesPerSecond += client.down_speed ?? 0;
                totals.totalUpKiloBytesPerSecond += client.up_speed ?? 0;
                return totals;
              },
              { totalDownKiloBytesPerSecond: 0, totalUpKiloBytesPerSecond: 0 },
            );

          // Update capabilities with total download and upload speeds
          await this.updateCapability(
            'measure_down_kilo_bytes_per_second',
            totalDownKiloBytesPerSecond,
          );
          await this.updateCapability(
            'measure_up_kilo_bytes_per_second',
            totalUpKiloBytesPerSecond,
          );

          // Trigger flow cards if CPU or memory usage has changed
          await this.triggerUsageFlowCards(
            resultCpuUsage,
            resultMemUsage,
            settings.hostname,
          );

          // LTE data usage — auto-detected: capabilities are added/removed based on API response
          await this.updateLteMetrics((device as any).imei as string | undefined);
        }
      }
    } catch (error) {
      this.error('Failed to update device metrics', error);
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Handles WAN state changes for IPv4 and IPv6.
   * Triggers flow cards if the WAN state has changed.
   * @param ipVersion - 'ipv4' or 'ipv6'.
   * @param inetStatus - The current internet status.
   * @param savedWanState - The previously saved WAN state.
   * @param capabilityName - The capability name to update.
   */
  private async handleWanStateChange(
    ipVersion: 'ipv4' | 'ipv6',
    inetStatus: string,
    savedWanState: boolean,
    capabilityName: string,
  ) {
    try {
      // Determine current WAN status
      const currentWanStatus = inetStatus?.toLowerCase() !== 'online';

      // Check if WAN status has changed
      if (currentWanStatus !== savedWanState) {
        const cardTriggerWanStatus = this.homey.flow.getDeviceTriggerCard(
          'alarm_wan_state_changed',
        );

        // Trigger flow card for WAN state change
        await cardTriggerWanStatus.trigger(this, {
          wan_state: currentWanStatus,
          ip_version: ipVersion,
        });

        // Update saved WAN state
        this[`savedWan${ipVersion}State`] = currentWanStatus;
      }

      // Update capability with current WAN status
      await this.updateCapability(capabilityName, currentWanStatus);
    } catch (err) {
      this.error(
        `Failed to handle WAN ${ipVersion} state change for device: ${
          this.getName() ?? 'Unknown Device'
        }`,
        err,
      );
    }
  }

  /**
   * Triggers flow cards for CPU and memory usage changes.
   * @param resultCpuUsage - The current CPU usage percentage.
   * @param resultMemUsage - The current memory usage percentage.
   * @param hostname - The hostname of the device.
   */
  private async triggerUsageFlowCards(
    resultCpuUsage: number,
    resultMemUsage: number,
    hostname: string,
  ) {
    try {
      // Trigger flow card for CPU usage change
      if (
        typeof resultCpuUsage === 'number' &&
        resultCpuUsage !== this.savedCpuUsage
      ) {
        const cardTriggerCpuUsage =
          this.homey.flow.getTriggerCard('cpu_usage');
        await cardTriggerCpuUsage.trigger({
          cpu_usage: resultCpuUsage,
        });
        // Update saved CPU usage
        this.savedCpuUsage = resultCpuUsage;
      }

      // Trigger flow card for memory usage change
      if (
        typeof resultMemUsage === 'number' &&
        resultMemUsage !== this.savedMemUsage
      ) {
        const cardTriggerMemUsage =
          this.homey.flow.getTriggerCard('mem_usage');
        await cardTriggerMemUsage.trigger({
          mem_usage: resultMemUsage,
        });
        // Update saved memory usage
        this.savedMemUsage = resultMemUsage;
      }
    } catch (err) {
      this.error('Failed to trigger usage flow cards', err);
    }
  }

  /**
   * Handles client state changes by comparing the current client list with the previous one.
   * Triggers flow cards when clients go online or offline.
   * Also maintains the persistent 30-day trackedClients history.
   * @param clientList - The current list of clients (online on this node right now).
   * @param decoNodeNames - Map of Deco node MAC (uppercase) → friendly display name.
   */
  private async handleClientStateChanges(clientList: any[], decoNodeNames: Map<string, string> = new Map()) {
    try {
      const clientStateFlow = this.homey.flow.getDeviceTriggerCard('client_state_changed');
      const anyClientStateFlow = this.homey.flow.getDeviceTriggerCard('any_client_state_changed');
      const clientFirstSeenFlow = this.homey.flow.getDeviceTriggerCard('client_first_seen');
      const clientNodeChangedFlow = this.homey.flow.getDeviceTriggerCard('client_node_changed');
      const now = Date.now();

      const resolveNodeName = (accessHost: string | undefined): string => {
        if (!accessHost) return '';
        return decoNodeNames.get(accessHost.toUpperCase()) ?? accessHost;
      };

      // Maps for quick lookup
      const lastClientsMap = new Map(
        this.clients?.map((client) => [client.mac, client]),
      );
      const currentClientsMap = new Map(
        clientList.map((client) => [client.mac, client]),
      );

      // Clients that have come online
      for (const [mac, client] of currentClientsMap) {
        this.nodeOfflineMisses.delete(mac);
        const decodedName = (this.driver as TplinkDecoDriver).decodeNickname(client.name);
        const isFirstSeen = !this.trackedClients[mac];
        const previousAccessHost = this.trackedClients[mac]?.access_host;
        const currentAccessHost: string = client.access_host ?? '';

        const tokens = {
          name: decodedName,
          ipaddr: client.ip,
          mac: client.mac,
          type: client.client_type ?? '',
          connection_type: client.connection_type ?? '',
          interface: client.interface ?? '',
          down_speed: client.down_speed ?? 0,
          up_speed: client.up_speed ?? 0,
        };

        // Update persistent history
        this.trackedClients[mac] = {
          mac: client.mac,
          name: decodedName,
          ip: client.ip,
          type: client.client_type ?? '',
          online: true,
          lastSeen: now,
          firstSeen: this.trackedClients[mac]?.firstSeen ?? now,
          access_host: currentAccessHost,
        };

        if (!lastClientsMap.has(mac)) {
          // Client came online — fire specific and generic cards
          await clientStateFlow.trigger(this, tokens, {
            status: 'online',
            client: tokens,
          });
          await anyClientStateFlow.trigger(this, { ...tokens, status: 'online' }, { status: 'online' });

          // Fire first-seen card if this client has never appeared before
          if (isFirstSeen) {
            await clientFirstSeenFlow.trigger(this, {
              name: decodedName,
              mac: client.mac,
              ipaddr: client.ip,
              connection_type: client.connection_type ?? '',
            });
          }
        }

        // Fire node-changed card if the client moved to a different Deco node
        if (
          !isFirstSeen &&
          currentAccessHost &&
          previousAccessHost &&
          currentAccessHost.toUpperCase() !== previousAccessHost.toUpperCase()
        ) {
          await clientNodeChangedFlow.trigger(
            this,
            {
              name: decodedName,
              mac: client.mac,
              deco_node: resolveNodeName(currentAccessHost),
              previous_node: resolveNodeName(previousAccessHost),
            },
            { mac: client.mac },
          );
        }
      }

      // Clients that have gone offline.
      //
      // Debounced by NODE_OFFLINE_GRACE_POLLS, the same way the mesh-wide cards
      // already are. A user reported getting an offline *and* an online message
      // every single minute while at home, with the phone sitting on one and the
      // same Deco the whole time — the router's per-node client list simply drops
      // an idle client now and then. Firing a Flow on the first miss turns that
      // into a presence automation that runs continuously. One confirming miss
      // costs a poll interval of latency and removes the flapping.
      for (const [mac, client] of lastClientsMap) {
        if (!currentClientsMap.has(mac)) {
          const misses = (this.nodeOfflineMisses.get(mac) ?? 0) + 1;
          if (misses < NODE_OFFLINE_GRACE_POLLS) {
            this.nodeOfflineMisses.set(mac, misses);
            // Keep it in this.clients so the next poll still compares against it.
            currentClientsMap.set(mac, client);
            continue;
          }
          this.nodeOfflineMisses.delete(mac);
          const decodedName = (this.driver as TplinkDecoDriver).decodeNickname(client.name);
          const tokens = {
            name: decodedName,
            ipaddr: client.ip,
            mac: client.mac,
            type: client.client_type ?? '',
            connection_type: client.connection_type ?? '',
            interface: client.interface ?? '',
            down_speed: 0,
            up_speed: 0,
          };

          // Mark as offline in persistent history (keep lastSeen from when they were last online)
          if (this.trackedClients[mac]) {
            this.trackedClients[mac].online = false;
          }

          await clientStateFlow.trigger(this, tokens, {
            status: 'offline',
            client: tokens,
          });
          await anyClientStateFlow.trigger(this, { ...tokens, status: 'offline' }, { status: 'offline' });
        }
      }

      // Drop miss counters for clients we are no longer tracking at all, so the
      // map can't grow without bound on a network with churn.
      for (const mac of this.nodeOfflineMisses.keys()) {
        if (!currentClientsMap.has(mac)) this.nodeOfflineMisses.delete(mac);
      }

      // Prune clients not seen for more than 30 days
      for (const [mac, tracked] of Object.entries(this.trackedClients)) {
        if (!tracked.online && now - tracked.lastSeen > TRACKED_CLIENT_TTL_MS) {
          delete this.trackedClients[mac];
        }
      }

      // Persist updated history
      await this.setStoreValue('trackedClients', this.trackedClients);

      // Update the current online list for the next comparison
      // Carry the debounced-but-still-missing clients forward, rather than
      // overwriting with the raw API list. Assigning clientList here discarded
      // the entries the offline debounce had just re-inserted into
      // currentClientsMap: on the next poll the client was no longer in
      // lastClientsMap at all, so the offline branch never ran and the trigger
      // was suppressed permanently instead of delayed — while the "online"
      // trigger still fired when it came back, i.e. exactly half of the
      // flapping this was meant to fix.
      this.clients = Array.from(currentClientsMap.values());
    } catch (err) {
      this.error('Failed to handle client state changes', err);
    }
  }

  /**
   * Handles mesh-wide presence by comparing the current mesh-wide client list (merged
   * from each node's own client list, master only) against the persistent
   * meshTrackedClients history. Fires the global client_joined_mesh / client_left_mesh
   * triggers.
   *
   * "Left" is debounced by MESH_LEFT_GRACE_POLLS consecutive misses so a client that
   * briefly drops out while re-associating with a different node during normal roaming
   * does not produce a false leave/join pair.
   * @param meshClientList - Every client currently connected anywhere in the mesh.
   * @param decoNodeNames - Map of Deco node MAC (uppercase) → friendly display name.
   */
  private async handleMeshPresence(meshClientList: any[], decoNodeNames: Map<string, string> = new Map()) {
    try {
      const joinedFlow = this.homey.flow.getTriggerCard('client_joined_mesh');
      const leftFlow = this.homey.flow.getTriggerCard('client_left_mesh');
      const now = Date.now();

      const currentClientsMap = new Map(
        meshClientList.map((client) => [client.mac, client]),
      );

      // Clients present now — joined if they weren't considered online before
      for (const [mac, client] of currentClientsMap) {
        const decodedName = (this.driver as TplinkDecoDriver).decodeNickname(client.name);
        const wasOnline = this.meshTrackedClients[mac]?.online === true;
        const currentAccessHost: string = client.access_host ?? '';

        const tokens = {
          name: decodedName,
          ipaddr: client.ip,
          mac: client.mac,
          connection_type: client.connection_type ?? '',
          deco_node: decoNodeNames.get(currentAccessHost.toUpperCase()) ?? currentAccessHost,
        };

        this.meshTrackedClients[mac] = {
          mac: client.mac,
          name: decodedName,
          ip: client.ip,
          type: client.client_type ?? '',
          online: true,
          lastSeen: now,
          firstSeen: this.meshTrackedClients[mac]?.firstSeen ?? now,
          access_host: currentAccessHost,
          missedPolls: 0,
        };

        if (!wasOnline) {
          await joinedFlow.trigger(tokens, { mac: client.mac });
        }
      }

      // Clients tracked as online but absent from this snapshot — debounce before declaring left
      for (const [mac, tracked] of Object.entries(this.meshTrackedClients)) {
        if (tracked.online && !currentClientsMap.has(mac)) {
          tracked.missedPolls += 1;
          if (tracked.missedPolls >= MESH_LEFT_GRACE_POLLS) {
            tracked.online = false;
            await leftFlow.trigger(
              {
                name: tracked.name,
                ipaddr: tracked.ip,
                mac: tracked.mac,
              },
              { mac: tracked.mac },
            );
          }
        }
      }

      // Prune clients not seen for more than 30 days
      for (const [mac, tracked] of Object.entries(this.meshTrackedClients)) {
        if (!tracked.online && now - tracked.lastSeen > TRACKED_CLIENT_TTL_MS) {
          delete this.meshTrackedClients[mac];
        }
      }

      await this.setStoreValue('meshTrackedClients', this.meshTrackedClients);
    } catch (err) {
      this.error('Failed to handle mesh presence', err);
    }
  }

  /**
   * Fetches cellular data-usage and connection-status metrics and updates capabilities.
   * Capabilities are added dynamically when the router responds with valid data
   * and removed if no working endpoint is found (non-cellular models).
   *
   * Probes two endpoint families on first call:
   *   lte_intf_cfg / lte_link_cfg  — 4G LTE models (e.g. X50-4G)
   *   5g_intf_cfg  / 5g_link_cfg   — 5G NR  models (e.g. X50-5G, if supported)
   * The working family is cached in lteFormCache so subsequent polls use it directly.
   *
   * Note on units: TP-Link firmware typically reports curStatistics / totalStatistics
   * in MB. The raw values are logged so unexpected values can be reported.
   */
  private async updateLteMetrics(imei?: string): Promise<void> {
    const LTE_CAPS = [
      'measure_lte_monthly_rx_mb',
      'measure_lte_monthly_tx_mb',
      'lte_sim_status',
      'lte_network_type',
    ] as const;

    const removeCaps = async () => {
      for (const cap of LTE_CAPS) {
        if (this.hasCapability(cap)) await this.removeCapability(cap);
      }
    };

    const defaultResp = { error_code: 1, result: {} };
    const hasData = (r: { error_code: number; result: any }) =>
      r.error_code === 0 && r.result != null && Object.keys(r.result).length > 0;

    // Fast path: already confirmed this device has no cellular API
    if (this.lteFormCache === null) {
      await removeCaps();
      return;
    }

    let intfCfg: LteIntfCfgResponse;
    let linkCfg: LteLinkCfgResponse;

    if (this.lteFormCache === undefined) {
      // --- First call: probe which endpoint family works ---
      // Always try 'lte' first (works for all 4G models).
      // On cellular models (IMEI present), also probe '5g' and 'nr' (5G NR).
      const probePrefixes = imei ? ['lte', '5g', 'nr'] : ['lte'];
      let detectedIntfCfg: LteIntfCfgResponse | undefined;

      for (const prefix of probePrefixes) {
        // silent=true: 2 of 3 prefixes failing with "no such callback" is the
        // expected outcome here (a model only supports one of lte/5g/nr, if
        // any) — not worth logging as an error on every poll cycle.
        const probe = await this.safeApiCall<LteIntfCfgResponse>(
          () => this.api.custom('/admin/network', { form: `${prefix}_intf_cfg` }, this.readBody, true),
          defaultResp,
          `${prefix}_intf_cfg probe`,
        );
        if (hasData(probe)) {
          this.lteFormCache = prefix;
          this.log(`updateLteMetrics: ${prefix}_intf_cfg works — caching cellular endpoint as "${prefix}"`);
          detectedIntfCfg = probe;
          break;
        }
      }

      if (!detectedIntfCfg) {
        this.lteFormCache = null;
        if (imei) {
          this.log(
            `updateLteMetrics: cellular model (IMEI ${imei}) has no LTE/5G/NR API endpoint — capabilities unavailable`,
          );
        }
        await removeCaps();
        return;
      }

      intfCfg = detectedIntfCfg;

      // Fetch the link config for the discovered family
      const linkForm = `${this.lteFormCache}_link_cfg`;
      linkCfg = await this.safeApiCall<LteLinkCfgResponse>(
        () => this.api.custom('/admin/network', { form: linkForm }, this.readBody),
        defaultResp,
        linkForm,
      );
    } else {
      // --- Subsequent calls: use cached form directly ---
      const prefix = this.lteFormCache as string;
      const intfForm = `${prefix}_intf_cfg`;
      const linkForm = `${prefix}_link_cfg`;

      intfCfg = await this.safeApiCall<LteIntfCfgResponse>(
        () => this.api.custom('/admin/network', { form: intfForm }, this.readBody),
        defaultResp,
        intfForm,
      );
      linkCfg = await this.safeApiCall<LteLinkCfgResponse>(
        () => this.api.custom('/admin/network', { form: linkForm }, this.readBody),
        defaultResp,
        linkForm,
      );

      if (!hasData(intfCfg)) {
        // Endpoint stopped responding — reset cache so next poll re-probes
        this.lteFormCache = undefined;
        await removeCaps();
        return;
      }
    }

    // Add capabilities on first detection
    for (const cap of LTE_CAPS) {
      if (!this.hasCapability(cap)) await this.addCapability(cap);
    }

    // Parse usage values — firmware reports in MB (as string or number)
    const toMb = (v: string | number | undefined): number => {
      const n = Number(v ?? 0);
      return isNaN(n) ? 0 : Math.round(n * 10) / 10;
    };

    // curStatistics  = current billing-period total usage (combined RX+TX) in MB
    // totalStatistics = cumulative total since device reset — map to TX cap so users
    //                   can calculate the delta themselves in flows if needed.
    // curRxSpeed / curTxSpeed = instantaneous speeds (not stored separately here).
    // Log raw values — report unexpected numbers so unit handling can be adjusted.
    const rxMb = toMb(intfCfg.result.curStatistics);
    const txMb = toMb(intfCfg.result.totalStatistics);
    this.log(
      `LTE/5G stats raw: curStatistics=${intfCfg.result.curStatistics}` +
      ` totalStatistics=${intfCfg.result.totalStatistics}` +
      ` curRxSpeed=${intfCfg.result.curRxSpeed} curTxSpeed=${intfCfg.result.curTxSpeed}`,
    );

    await this.updateCapability('measure_lte_monthly_rx_mb', rxMb);
    await this.updateCapability('measure_lte_monthly_tx_mb', txMb);

    // Normalise SIM status strings from firmware (e.g. "sim_ready" → "Ready")
    const simRaw = (linkCfg as LteLinkCfgResponse).result?.simStatus ?? '';
    const simLabel = simRaw
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()) || '–';
    await this.updateCapability('lte_sim_status', simLabel);

    const networkRaw = (linkCfg as LteLinkCfgResponse).result?.networkType ?? '';
    const networkLabel = networkRaw.toUpperCase() || '–';
    await this.updateCapability('lte_network_type', networkLabel);
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

  /**
   * Updates a device capability with the provided value.
   * @param capability - The name of the capability to update.
   * @param value - The value to set for the capability.
   */
  private async updateCapability(capability: string, value: any) {
    try {
      const currentValue = this.getCapabilityValue(capability);
      if (currentValue !== value) {
        await this.setCapabilityValue(capability, value);
      }
    } catch (err) {
      this.error(`Failed to update capability ${capability}`, err);
    }
  }

  /**
   * Logs debug messages if debug mode is enabled.
   * @param message - The debug message to log.
   * @param data - Optional data to log with the message.
   */
  private debug(message: string, data?: any) {
    if (this.debugEnabled) {
      if (data !== undefined) {
        this.log(`DEBUG: ${message}`, JSON.stringify(redactSecrets(data), null, 2));
      } else {
        this.log(`DEBUG: ${message}`);
      }
    }
  }
}

module.exports = TplinkDecoDevice;
