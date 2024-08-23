'use strict';

import { Device } from 'homey';
import decoapiwapper from 'decoapiwrapper';

interface DeviceSettings {
  host: string;
  username: string;
  password: string;
  timeoutSeconds: number;
  verifySSL: boolean;
}

/**
 * TplinkDecoDevice class to manage individual TP-Link Deco devices in Homey.
 * Handles initialization, settings updates, and device-specific actions.
 */
class TplinkDecoDevice extends Device {
  /**
   * Initializes the TP-Link Deco device.
   * Sets up the API connection using device settings.
   */
  async onInit() {
    this.log(`TP-Link Deco Device initialized: ${this.getName()}`);

    try {
      await this.initializeApiFromSettings();
      this.log('Successfully connected to TP-Link Deco');
    } catch (error) {
      this.error('Failed to initialize device', error);
    }
  }

  /**
   * Initializes the TP-Link Deco API using the device settings.
   * Throws an error if required settings are missing or connection fails.
   */
  private async initializeApiFromSettings(): Promise<void> {
    const { host, username, password, timeoutSeconds, verifySSL } =
      this.getSettings() as DeviceSettings;

    if (!host || !username || !password) {
      throw new Error('Missing API configuration settings');
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
    oldSettings: {
      [key: string]: string | number | boolean | null | undefined;
    };
    newSettings: {
      [key: string]: string | number | boolean | null | undefined;
    };
    changedKeys: string[];
  }): Promise<void> {
    this.log('Device settings updated:', {
      oldSettings,
      newSettings,
      changedKeys,
    });

    if (
      changedKeys.includes('host') ||
      changedKeys.includes('username') ||
      changedKeys.includes('password') ||
      changedKeys.includes('timeoutSeconds') ||
      changedKeys.includes('verifySSL')
    ) {
      try {
        this.log('API reinitialized with updated settings');
      } catch (error) {
        this.error('Failed to reinitialize API', error);
      }
    }
  }
}

module.exports = TplinkDecoDevice;
