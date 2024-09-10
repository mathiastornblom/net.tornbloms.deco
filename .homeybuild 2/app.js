'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const { Log } = require('homey-log');
const HomeyLog = require('homey-betterstack');
// Start debuger
if (process.env.DEBUG === '1') {
    require('inspector').open(9229, '0.0.0.0');
}
class TplinkDecoApp extends HomeyLog {
    constructor() {
        super(...arguments);
        this.api = null;
        this.debugEnabled = this.homey.settings.get('debugenabled') || false;
    }
    async onInit() {
        this.homeyLog = new Log({ homey: this.homey });
        this.log(`${this.homey.manifest.id} - ${this.homey.manifest.version} started...`);
    }
    async onUninit() {
        this.log('TP-Link Deco app has been uninitialized');
    }
}
module.exports = TplinkDecoApp;
//# sourceMappingURL=app.js.map