'use strict';

import Homey from 'homey';
import decoapiwrapper from 'decoapiwrapper';

// Start debuger
if (process.env.DEBUG === '1') {
  require('inspector').open(9229, '0.0.0.0');
}

class TplinkDecoApp extends Homey.App {
  private api: decoapiwrapper | null = null;

  async onInit(): Promise<void> {
    this.log('TP-Link Deco app has been initialized');
  }

  async onUninit() {
    this.log('TP-Link Deco app has been uninitialized');
  }
}

module.exports = TplinkDecoApp;
