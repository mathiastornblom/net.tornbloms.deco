'use strict';
import crypto from 'crypto';
import { Driver } from 'homey';
import decoapiwrapper from '../../lib/client';
import { DeviceListResponse } from '../../lib/client';

class TplinkDecoDriver extends Driver {
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;
  private api: decoapiwrapper | any;

  // Buffer for read operations
  readBody = Buffer.from('{"operation": "read"}');

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
    let password = '';

    // Received when a view has changed
    session.setHandler('showView', async (viewId: string) => {
      console.log('View: ' + viewId);
    });

    session.setHandler(
      'login',
      async (data: { username: string; password: string }) => {
        this.log('pair: login');
        hostname = data.username.replace(/^http:\/\/|^https:\/\//i, '').trim();
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
          const devices = deviceList.result.device_list.map((device) => ({
            name:
              device.device_model +
              ' - ' +
              this.cleanString(this.decodeBase64(device.nickname)),
            data: {
              id: device.mac,
            },
            settings: {
              name:
                device.device_model +
                ' - ' +
                this.cleanString(this.decodeBase64(device.nickname)),
              mac: device.mac,
              hostname: device.device_ip,
              password: password,
              model: device.device_model,
              ip: device.device_ip,
              role: device.role,
              hardware_ver: device.hardware_ver,
              software_ver: device.software_ver,
              hw_id: device.hw_id,
              timeoutSeconds: 10,
            },
          }));
          this.log(devices);
          if (this.debugEnabled) {
            this.homey.app.log(
              `driver.ts:onInit() driver: `,
              JSON.stringify(devices, null, 2),
            );
          }
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
          const api = new decoapiwrapper(hostname);
          const result = await api.authenticate(password);
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

  private cleanString(input: string): string {
    // Regular expression to match escape characters and control characters.
    const escapeCharsRegex = /\\[\'\"\\nrtbfv0x0B\xFF]|[\x00-\x1F\x7F]/g;

    // Remove escape and control characters, and trim leading and trailing spaces in one step.
    return input.replace(escapeCharsRegex, '').trim();
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

module.exports = TplinkDecoDriver;
