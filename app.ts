'use strict';

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

  async onInit(): Promise<void> {
    this.homeyLog = new Log({ homey: this.homey });
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} started...`,
    );
  }

  async onUninit() {
    this.log('TP-Link Deco app has been uninitialized');
  }
}

module.exports = TplinkDecoApp;
