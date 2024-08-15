'use strict';

import { Device } from 'homey';
import TplinkDecoApi from '../../lib/api.ts';

interface DeviceSettings {
  host: string;
  username: string;
  password: string;
  timeoutSeconds: number; // Changed to camelCase
  verifySSL: boolean; // Changed to camelCase
}

class TplinkDecoDevice extends Device {

  private api: TplinkDecoApi | null = null;

  async onInit() {
    this.log(`TP-Link Deco Device has been initialized: ${this.getName()}`);

    // Fetch device settings
    const {
      host, username, password, timeoutSeconds, verifySSL,
    } = this.getSettings() as DeviceSettings;

    // Initialize the API
    if (host && username && password) {
      this.api = new TplinkDecoApi({
        host,
        username,
        password,
        timeoutSeconds,
        verifySSL,
      });

      try {
        await this.api.testConnection();
        this.log('Successfully connected to TP-Link Deco');
      } catch (error) {
        this.error('Failed to connect to TP-Link Deco', error);
      }
    } else {
      this.error('Missing API configuration settings');
    }
  }

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
      changedKeys.includes('host')
      || changedKeys.includes('username')
      || changedKeys.includes('password')
      || changedKeys.includes('timeoutSeconds')
      || changedKeys.includes('verifySSL')
    ) {
      await this.onInit(); // Reinitialize with updated settings
    }
  }

  async setDevicePower(value: boolean): Promise<void> {
    if (!this.api) {
      this.error('API not initialized');
      throw new Error('API not initialized');
    }

    try {
      if (value) {
        // Implement the power on functionality
        this.log(`Powered on device: ${this.getName()}`);
      } else {
        // Implement the power off functionality
        this.log(`Powered off device: ${this.getName()}`);
      }
    } catch (error) {
      this.error('Error setting device power', error);
      throw new Error('Error setting device power');
    }
  }

  async getDeviceMetrics() {
    if (!this.api) {
      this.error('API not initialized');
      throw new Error('API not initialized');
    }

    try {
      const metrics = await this.api.getConnectedDevices(); // Replace with actual API call to fetch metrics
      this.log(`Fetched device metrics for ${this.getName()}:`, metrics);
      // Process and use the metrics as needed
    } catch (error) {
      this.error('Error fetching device metrics', error);
      throw new Error('Error fetching device metrics');
    }
  }

}

module.exports = TplinkDecoDevice;
