'use strict';

import Homey from 'homey';
import decoapiwrapper from './lib/client';
const { Log } = require('homey-log');
const HomeyLog = require('homey-betterstack');



class TplinkDecoApp extends HomeyLog {
  private api: decoapiwrapper | null = null;
  homeyLog: any;
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;
  async onInit(): Promise<void> {
    this.homeyLog = new Log({ homey: this.homey });
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} started...`,
    );
  }

  async onUninit() {
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} has been uninitialised`,
    );
  }
}

module.exports = TplinkDecoApp;
