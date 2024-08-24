'use strict';

import Homey from 'homey';
import decoapiwapper from 'decoapiwrapper';

class TplinkDecoApp extends Homey.App {
  private api: decoapiwapper | null = null;

  async onInit(): Promise<void> {
    this.log('TP-Link Deco app has been initialized');

    // // Initialize the API
    const hostname = this.homey.settings.get('hostname');
    const password = this.homey.settings.get('password');

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

  async onUninit() {
    this.log('TP-Link Deco app has been uninitialized');
  }
}

module.exports = TplinkDecoApp;
