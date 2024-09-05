'use strict';
import crypto from 'crypto';
import { Driver } from 'homey';
import decoapiwrapper from 'decoapiwrapper';
import { DeviceListResponse } from 'decoapiwrapper';

class TplinkDecoDriver extends Driver {
  private api: decoapiwrapper | null = null;
  /**
   * Called when the driver is initialized.
   * Checks if API settings are available; if not, waits for user input.
   */
  async onInit() {
    this.log('TP-Link Deco Driver has been initialized');
  }

  /**
   * Handles the pairing process for adding a new TP-Link Deco device.
   * @param session - The pairing session object provided by Homey.
   */
  async onPair(session: any): Promise<void> {
    this.log('Starting pairing process');

    let hostname = '';
    let username = 'admin';
    let password = '';

    // Received when a view has changed
    session.setHandler('showView', async (viewId: string) => {
      console.log('View: ' + viewId);
    });

    session.setHandler(
      'login',
      async (data: { username: string; password: string }) => {
        this.log('pair: login');
        hostname = data.username;
        this.log('hostname: ', hostname);
        password = data.password;
        this.log('password: ', password);
        this.log('creating client');
        try {
          this.api = new decoapiwrapper(hostname);
          const result = (await this.api.authenticate(password)) as boolean;
          this.log('result: ', result);
          if (result) {
            this.log('Successfully connected to TP-Link Deco');
            return true;
          } else {
            this.log('Failed to connect to TP-Link Deco');
            return false;
          }
        } catch (error) {
          this.error('Failed to connect to TP-Link Deco', error);
          return false;
        }
      },
    );

    session.setHandler('list_devices', async () => {
      this.log('pair: list_devices');
      if (!this.api) {
        this.error('No API instance available');
        return [];
      }
      try {
        const deviceList = (await this.api.deviceList()) as DeviceListResponse;
        if (
          deviceList.error_code === 0 &&
          deviceList.result.device_list.length > 0
        ) {
          const devices = deviceList.result.device_list.map((device) => ({
            name:
              this.decodeBase64(device.custom_nickname) || device.device_model,
            data: {
              id: device.mac,
              hostname: hostname,
              username: username,
              password: password,
              ip: hostname,
            },
            settings: {
              hostname,
              username,
              password,
              timeoutSeconds: 10,
            },
          }));
          this.log(devices);
          return devices;
        } else {
          this.error('Failed to retrieve device information');
        }
      } catch (error) {
        this.error('Failed to retrieve device information', error);
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
    // Logga session för att verifiera dess innehåll
    this.log('Session data before setHandler:', JSON.stringify(session));

    session.setHandler(
      'repair',
      async (data: { username: string; password: string }) => {
        this.log('pair: repairing');
        hostname = data.username;
        this.log('hostname: ', hostname);
        password = data.password;
        this.log('password: ', password);
        this.log('repairing client');
        try {
          this.api = new decoapiwrapper(hostname);
          const result = await this.api.authenticate(password);
          if (result) {
            this.log('Successfully connected to TP-Link Deco');
            return { success: true };
          } else {
            this.log('Failed to connect to TP-Link Deco');
            return { success: false, error: 'Authentication failed' };
          }
        } catch (error) {
          this.error('Failed to connect to TP-Link Deco', error);
          return { success: false, error: error || 'Unknown error' };
        }
      },
    );
  }

  // If no error do respond with result
  private decodeBase64(encoded: string | undefined): string {
    if (!encoded) {
      this.error('driver.ts: No string provided for decoding');
      return '';
    }

    // Check if the string is base64 encoded
    const base64Regex =
      /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/;
    if (!base64Regex.test(encoded)) {
      this.error('driver.ts: Provided string is not base64 encoded');
      return encoded;
    }

    try {
      return Buffer.from(encoded, 'base64').toString('utf-8');
    } catch (e) {
      this.error(`driver.ts: Failed to decode base64 string: ${encoded}`, e);
      return encoded; // Return the original string if decoding fails
    }
  }
}

module.exports = TplinkDecoDriver;
