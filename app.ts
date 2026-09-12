'use strict';

// Deco routers use self-signed TLS certificates on their HTTPS admin interface.
// This app exclusively connects to local-network devices so certificate
// verification is intentionally disabled for the entire process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// See lib/utils/memoryUsageGuard.ts for why: in short, a throw inside
// process.memoryUsage() on some constrained Homey models otherwise crashes
// winston's uncaughtException handler (registered by homey-betterstack below)
// uncatchably, masking the app's real error and preventing it from ever
// reaching Sentry. Must run before that handler is ever installed, i.e. before
// anything below has a chance to construct the app.
import { installMemoryUsageGuard } from './lib/utils/memoryUsageGuard';
installMemoryUsageGuard();

import Homey from 'homey';
import decoapiwrapper from './lib/client';
const { Log } = require('homey-log');
const HomeyLog = require('homey-betterstack');

// Start debuger
if (process.env.DEBUG === '1') {
  require('inspector').open(9229, '0.0.0.0');
}

class TplinkDecoApp extends HomeyLog {
  private api: decoapiwrapper | null = null;
  homeyLog: any;
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;
  async onInit(): Promise<void> {
    // homey-log's underlying Raven client defaults sendTimeout to 1 second
    // (raven-node lib/client.js: `this.sendTimeout = options.sendTimeout || 1`),
    // which is too tight for a home-network device reaching Sentry's ingest
    // endpoint — DNS + TLS handshake + POST routinely exceeds 1s, causing every
    // report to fail with ETIMEDOUT/socket hang up and never reach Sentry.
    this.homeyLog = new Log({ homey: this.homey, options: { sendTimeout: 15 } });
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} started...`,
    );
  }

  /**
   * Sends a non-fatal issue to Sentry (via homey-log), for failures that are caught
   * and logged locally but would otherwise never leave the device's own log.
   * `homey-log` dedupes by exact message string, so a stable, templated message
   * (no per-call timestamps/random ids) reports a given failure once per app run
   * instead of flooding Sentry on every poll cycle.
   */
  reportIssue(message: string, extra?: Record<string, any>): void {
    if (!this.homeyLog) return;
    if (extra) {
      this.homeyLog.setExtra(extra);
    }
    this.homeyLog.captureMessage(message).catch((e: any) => this.error('reportIssue: failed to send to Sentry', e));
  }

  async onUninit() {
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} has been uninitialised`,
    );

    // A crash report from a Homey (Early 2019) ended with:
    //   "Cannot access `this.homey.app` because the app instance has been
    //    destroyed. This may indicate that your app is not cleaning up all
    //    resources in `onUninit()`."
    // Devices clear their own poll intervals and one-shot timers in their own
    // onUninit (added in the same release — there was none before, so those
    // timers used to survive shutdown). Nothing released the driver-level state: the
    // shared API clients (each holding an open session and cookie jar), the
    // in-flight auth promises, and the merged per-node client lists all
    // survived shutdown. Release them here so a restart starts clean rather
    // than on top of the previous process's leftovers.
    // Guarded: this runs while the app is being torn down, which is exactly when
    // a stray call — including the log line inside releaseResources() — can
    // throw. An onUninit that rejects is the failure mode being fixed here, not
    // an acceptable way to report one.
    try {
      for (const driver of Object.values(this.homey.drivers.getDrivers())) {
        (driver as any).releaseResources?.();
      }
    } catch (e) {
      this.error('onUninit: releasing driver resources failed', e);
    }
  }
}

module.exports = TplinkDecoApp;
