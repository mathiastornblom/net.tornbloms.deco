'use strict';

import * as crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { Agent as HttpsAgent } from 'https'; // Replacing require with import

interface TplinkDecoApiOptions {
  host: string;
  username: string;
  password: string;
  timeoutSeconds: number;
  verifySSL: boolean;
}

export default class TplinkDecoApi {

  private host: string;
  private username: string;
  private password: string;
  private timeoutSeconds: number;
  private verifySSL: boolean;
  private client: AxiosInstance;
  private stok: string | null = null;

  constructor(options: TplinkDecoApiOptions) {
    this.host = options.host;
    this.username = options.username;
    this.password = options.password;
    this.timeoutSeconds = options.timeoutSeconds;
    this.verifySSL = options.verifySSL;

    this.client = axios.create({
      baseURL: this.host,
      timeout: this.timeoutSeconds * 1000,
      httpsAgent: new HttpsAgent({
        rejectUnauthorized: this.verifySSL,
      }),
    });
  }

  // Login and get the session token (stok)
  async login() {
    const loginPayload = {
      method: 'do',
      login: {
        password: this.encryptPassword(this.password),
      },
    };

    try {
      const response = await this.client.post(
        '/cgi-bin/luci/;stok=/login',
        loginPayload,
      );
      if (response.data.error_code === 0) {
        this.stok = response.data.stok;
        return this.stok;
      }
      throw new Error(`Login failed: ${response.data.error_code}`);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to login to TP-Link Deco: ${error.message}`);
      } else {
        throw new Error('An unknown error occurred during login');
      }
    }
  }

  // Encrypt the password (this is a simplified example)
  private encryptPassword(password: string): string {
    // Here you should implement the actual encryption required by the Deco API
    return crypto.createHash('md5').update(password).digest('hex');
  }

  // Test connection by logging in
  async testConnection() {
    if (!this.stok) {
      await this.login();
    }
  }

  // Reboot a specific Deco device by its MAC address
  async rebootDevice(macAddress: string) {
    if (!this.stok) {
      await this.login();
    }

    const payload = {
      method: 'do',
      system: {
        reboot: { mac: macAddress },
      },
    };

    try {
      const response = await this.client.post(
        `/cgi-bin/luci/;stok=${this.stok}/admin/system`,
        payload,
      );
      if (response.data.error_code !== 0) {
        throw new Error(
          `Failed to reboot Deco device: ${response.data.error_code}`,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to reboot Deco device: ${error.message}`);
      } else {
        throw new Error('An unknown error occurred during reboot');
      }
    }
  }

  // Get a list of connected devices
  async getConnectedDevices() {
    if (!this.stok) {
      await this.login();
    }

    try {
      const response = await this.client.post(
        `/cgi-bin/luci/;stok=${this.stok}/admin/device`,
        {
          method: 'get',
        },
      );
      if (response.data.error_code === 0) {
        return response.data.result.device_list;
      }
      throw new Error(
        `Failed to retrieve device list: ${response.data.error_code}`,
      );
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to retrieve connected devices: ${error.message}`,
        );
      } else {
        throw new Error('An unknown error occurred while retrieving devices');
      }
    }
  }

  // Power on a device by its MAC address (example method)
  async powerOnDevice(macAddress: string) {
    if (!this.stok) {
      await this.login();
    }

    // Implement the API call to power on the device
    // This is a placeholder and may not reflect the real API
    const payload = {
      method: 'do',
      device: {
        mac: macAddress,
        action: 'power_on',
      },
    };

    try {
      const response = await this.client.post(
        `/cgi-bin/luci/;stok=${this.stok}/admin/device`,
        payload,
      );
      if (response.data.error_code !== 0) {
        throw new Error(
          `Failed to power on device: ${response.data.error_code}`,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to power on device: ${error.message}`);
      } else {
        throw new Error('An unknown error occurred during power on');
      }
    }
  }

  // Power off a device by its MAC address (example method)
  async powerOffDevice(macAddress: string) {
    if (!this.stok) {
      await this.login();
    }

    // Implement the API call to power off the device
    // This is a placeholder and may not reflect the real API
    const payload = {
      method: 'do',
      device: {
        mac: macAddress,
        action: 'power_off',
      },
    };

    try {
      const response = await this.client.post(
        `/cgi-bin/luci/;stok=${this.stok}/admin/device`,
        payload,
      );
      if (response.data.error_code !== 0) {
        throw new Error(
          `Failed to power off device: ${response.data.error_code}`,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to power off device: ${error.message}`);
      } else {
        throw new Error('An unknown error occurred during power off');
      }
    }
  }

  // Get device metrics by MAC address (example method)
  async getDeviceMetrics(macAddress: string) {
    if (!this.stok) {
      await this.login();
    }

    // Implement the API call to get device metrics
    // This is a placeholder and may not reflect the real API
    try {
      const response = await this.client.post(
        `/cgi-bin/luci/;stok=${this.stok}/admin/device`,
        {
          method: 'get_metrics',
          mac: macAddress,
        },
      );
      if (response.data.error_code === 0) {
        return response.data.result.metrics;
      }
      throw new Error(
        `Failed to retrieve device metrics: ${response.data.error_code}`,
      );
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to retrieve device metrics: ${error.message}`);
      } else {
        throw new Error(
          'An unknown error occurred while retrieving device metrics',
        );
      }
    }
  }

}
