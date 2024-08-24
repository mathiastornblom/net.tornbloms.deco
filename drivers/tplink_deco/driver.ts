'use strict';

import { Driver } from 'homey';
import decoapiwapper from 'decoapiwrapper';

class TplinkDecoDriver extends Driver {
  private api: decoapiwapper | null = null;
  /**
   * Called when the driver is initialized.
   * Checks if API settings are available; if not, waits for user input.
   */
  async onInit() {
    this.log('TP-Link Deco Driver has been initialized');

    // Fetch driver settings
    const hostname = this.homey.settings.get('hostname');
    const password = this.homey.settings.get('password');

    // Check if the API settings are available
    if (hostname && password) {
      this.api = new decoapiwapper(hostname);

      // Test API connection
      try {
        await this.api.authenticate(password);
        this.log('Successfully connected to TP-Link Deco');
      } catch (error) {
        this.error('Failed to connect to TP-Link Deco', error);
      }
    } else {
      this.error('Missing API configuration settings');
    }
  }

  /**
   * Handles the pairing process for adding a new TP-Link Deco device.
   * @param session - The pairing session object provided by Homey.
   */
  async onPair(session: any): Promise<void> {
    this.log('Starting pairing process');

    let host = '';
    let username = '';
    let password = '';
    let timeoutSeconds = 30;
    let verifySSL = true;

    // Received when a view has changed
    session.setHandler('showView', async function (viewId: string) {
      console.log('View: ' + viewId);
    });

    session.setHandler(
      'login',
      async (data: { username: string; password: string }) => {
        this.log('pair: login');
        username = data.username.trim();
        this.log('hostname: ', username);
        password = data.password;
        this.log('password: ', password);
        this.log('creating client');
      },
    );

    session.setHandler('list_devices', async () => {
      this.log('pair: list_devices');
      const devices = [
        {
          name: host,
          data: {
            id: host,
            username: username,
            password: password,
            ip: host,
          },
        },
      ];
      this.log(devices);
      return devices;
    });
  }
}

module.exports = TplinkDecoDriver;
