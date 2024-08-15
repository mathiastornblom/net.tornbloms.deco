'use strict';

import Homey from 'homey';
import TplinkDecoApi from './lib/api.ts';

class TplinkDecoApp extends Homey.App {

   private api: TplinkDecoApi | null = null;

   async onInit() {
     this.log('TP-Link Deco app has been initialized');

     // Initialize the API
     const host = this.homey.settings.get('host');
     const username = this.homey.settings.get('username');
     const password = this.homey.settings.get('password');
     const timeoutSeconds = this.homey.settings.get('timeout_seconds') || 30;
     const verifySSL = this.homey.settings.get('verify_ssl') || true;

     if (host && username && password) {
       this.api = new TplinkDecoApi({
         host,
         username,
         password,
         timeoutSeconds,
         verifySSL,
       });

       // Test API connection
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

   async onUninit() {
     this.log('TP-Link Deco app has been uninitialized');
   }

   // Example of a method to reboot a Deco device
   async rebootDeco(deviceId: string) {
     if (!this.api) {
       throw new Error('API not initialized');
     }

     try {
       await this.api.rebootDevice(deviceId);
       this.log(`Deco device with ID ${deviceId} has been rebooted`);
     } catch (error) {
       this.error(`Failed to reboot Deco device with ID ${deviceId}`, error);
     }
   }

}

module.exports = TplinkDecoApp;
