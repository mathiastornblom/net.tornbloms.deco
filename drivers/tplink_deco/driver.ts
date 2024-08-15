'use strict';

import { Driver } from 'homey';
import TplinkDecoApi from '../../lib/api.ts';

interface DeviceData {
  id: string;
  mac: string;
}

interface HomeyDevice {
  name: string;
  data: DeviceData;
  settings: {
    ipAdress: string;
    mac: string;
  };
}

class TplinkDecoDriver extends Driver {

  private api: TplinkDecoApi | null = null;

  async onInit() {
    this.log('TP-Link Deco Driver has been initialized');

    // Fetch driver settings
    const host = this.homey.settings.get('host');
    const username = this.homey.settings.get('username');
    const password = this.homey.settings.get('password');
    const timeoutSeconds = this.homey.settings.get('timeout_seconds') || 30;
    const verifySSL = this.homey.settings.get('verify_ssl') || true;

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
        this.error(
          'Failed to connect to TP-Link Deco',
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } else {
      this.error('Missing API configuration settings');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onPair(session: any): Promise<void> {
    this.log('Starting pairing process');

    // Handle login event
    session.on(
      'login',
      async (
        data: { host: string; username: string; password: string },
        callback: (err: string | null) => void, // Explicitly typing the callback parameter
      ) => {
        try {
          this.api = new TplinkDecoApi({
            host: data.host,
            username: data.username,
            password: data.password,
            timeoutSeconds: 30,
            verifySSL: true,
          });

          await this.api.testConnection();
          callback(null); // Indicate success
          session.emit('login_success');
        } catch (error) {
          this.error('Login failed:', error);
          callback(error instanceof Error ? error.message : String(error)); // Indicate failure
          session.emit(
            'login_error',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    // Handle list_devices event
    session.on(
      'list_devices',
      async (
        _data: unknown, // Explicitly typing _data as unknown
        callback: (err: Error | null, result?: HomeyDevice[]) => void,
      ) => {
        if (!this.api) {
          callback(new Error('API not initialized'));
          return;
        }

        try {
          const devices = await this.api.getConnectedDevices();
          const homeyDevices = devices.map(
            (device: {
              name: string;
              mac: string;
              ipAddress: string;
            }): HomeyDevice => {
              return {
                name: device.name,
                data: {
                  id: device.mac,
                  mac: device.mac,
                },
                settings: {
                  ipAdress: device.ipAddress, // keeping snake_case as this is what is returned from the API
                  mac: device.mac,
                },
              };
            },
          );
          callback(null, homeyDevices);
        } catch (error) {
          this.error(
            'Error fetching devices',
            error instanceof Error ? error : new Error(String(error)),
          );
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  }

}

module.exports = TplinkDecoDriver;
