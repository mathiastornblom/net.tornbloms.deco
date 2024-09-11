import crypto from 'crypto';
import { Device } from 'homey';
import decoapiwrapper from '../../lib/client';
import {
  DeviceListResponse,
  PerformanceResponse,
  WANResponse,
  ClientListResponse,
  InternetResponse,
  ErrorResponse,
} from '../../lib/client';

/**
 * TplinkDecoDevice class to manage individual TP-Link Deco devices in Homey.
 * Handles initialization, settings updates, and device-specific actions.
 */
class TplinkDecoDevice extends Device {
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;
  // Variables to store previous state values
  private savedDownKiloBytesPerSecond = 0;
  private savedUpKiloBytesPerSecond = 0;
  private savedCpuUsage = 0;
  private savedMemUsage = 0;
  private savedWanState = false;

  // Define interval ID properties to store interval identifiers
  private timeoutSecondsIntervalId: ReturnType<typeof setInterval> | null =
    null;
  private api: decoapiwrapper | any;

  connected = false; // Connection status
  clients: any[] = []; // List of connected clients

  /**
   * Initializes the TP-Link Deco device.
   * Sets up the API connection using device settings.
   */
  async onInit() {
    try {
      this.homey.app.log(
        `Device instance: ${this.getName()} (${this.getData().id})`,
      );

      // Retrieve device settings
      const settings = this.getSettings();
      this.homey.app.log(
        `${settings.hostname} onInit():settings: `,
        JSON.stringify(settings, null, 2),
      );

      // Retrieve device data
      const devicedata = this.getData();
      const logDebug = (message: string, data?: any) => {
        if (this.homey.settings.get('debug')) {
          this.homey.app.log(message, JSON.stringify(data, null, 2));
        }
      };

      logDebug(`${settings.hostname} onInit():devicedata: `, devicedata);

      this.log(`TP-Link Deco Device started initialized: ${this.getName()}`);
      this.homey.app.log(
        `TP-Link Deco Device started initialized: ${this.getName()}`,
      );
      if (settings.hostname && settings.password) {
        // Authenticate with the API
        this.api = new decoapiwrapper(settings.hostname);
        this.connected = await this.api
          .authenticate(settings.password)
          .catch((e) => {
            this.error('Failed to authenticate', e);
            this.homey.app.error('Failed to authenticate', e);
            return false;
          });
        this.log('Successfully connected to TP-Link Deco');
      } else {
        this.error('Missing API configuration settings');
        this.connected = false;
      }

      // Retrieve device list from the API
      const deviceList = (await this.api.deviceList()) as DeviceListResponse;
      if (this.homey.settings.get('debugenabled')) {
        this.homey.app.log(
          `${settings.hostname} onInit():deviceList: `,
          JSON.stringify(deviceList, null, 2),
        );
      }
      if (
        deviceList.error_code === 0 &&
        deviceList.result.device_list.length > 0
      ) {
        // Filter the device list to find the current device
        const device = deviceList.result.device_list.find(
          (d) => d.mac === devicedata.id,
        );
        if (this.homey.settings.get('debugenabled')) {
          this.homey.app.log(
            `${settings.hostname} onInit():Filtered device: `,
            JSON.stringify(device, null, 2),
          );
        }
        if (device) {
          // Update device settings with retrieved information
          await this.setSettings({
            hardware_ver: device.hardware_ver,
            software_ver: device.software_ver,
            role: device.role,
          });

          const performance = (await this.api.performance().catch((e) => {
            this.error('Failed to retrieve performance data', e);
            this.homey.app.error('Failed to retrieve performance data', e);
            return { error_code: 1, result: { cpu_usage: 0, mem_usage: 0 } }; // Return default values in case of error
          })) as PerformanceResponse;
          if (this.homey.settings.get('debugenabled')) {
            this.homey.app.log(
              `${settings.hostname} onInit():performance: `,
              JSON.stringify(performance, null, 2),
            );
          }
          this.savedCpuUsage = Math.round(
            Number(performance.result.cpu_usage) * 100,
          );
          this.savedMemUsage = Math.round(
            Number(performance.result.mem_usage) * 100,
          );
          const wlanResponse = (await this.api.getWAN().catch((e) => {
            this.error('Failed to retrieve WAN data', e);
            this.homey.app.error('Failed to retrieve WAN data', e);
            return { error_code: 1, result: {} }; // Return default values in case of error
          })) as WANResponse;
          if (this.homey.settings.get('debugenabled')) {
            this.homey.app.log(
              `${settings.hostname} onInit():wlanResponse: `,
              JSON.stringify(wlanResponse, null, 2),
            );
          }
          let clientList = (await this.api.clientList().catch((e) => {
            this.error('Failed to retrieve client list', e);
            this.homey.app.error('Failed to retrieve client list', e);
            return {
              error_code: 1,
              result: {
                client_list: [],
              },
            }; // Return default values in case of error
          })) as ClientListResponse;
          this.homey.app.log(
            `${settings.hostname} onInit():clientList: `,
            JSON.stringify(clientList, null, 2),
          );

          const internetResponse = (await this.api.getInternet().catch((e) => {
            this.error('Failed to retrieve internet data', e);
            this.homey.app.error('Failed to retrieve internet data', e);
            return { error_code: 1, result: {} }; // Return default values in case of error
          })) as InternetResponse;
          if (this.homey.settings.get('debugenabled')) {
            this.homey.app.log(
              `${settings.hostname} onInit():internetResponse: `,
              JSON.stringify(internetResponse, null, 2),
            );
          }
          const clientStateFlow = this.homey.flow.getDeviceTriggerCard(
            'client_state_changed',
          );
          const lastClients = this.clients;
          this.clients = clientList.result.client_list;

          for (const client of this.clients) {
            if (lastClients.length > 0) {
              if (
                !lastClients.find((obj) => {
                  return obj.mac === client.mac;
                })
              ) {
                const tokens = {
                  name: client.name,
                  ipaddr: client.ip,
                  mac: client.mac,
                };

                await clientStateFlow.trigger(this, tokens, {
                  status: 'online',
                  client: tokens,
                });
              }
            }
          }

          if (lastClients.length > 0) {
            for (const client of lastClients) {
              if (
                !this.clients.find((obj) => {
                  return obj.mac === client.mac;
                })
              ) {
                const tokens = {
                  name: client.name,
                  ipaddr: client.ip,
                  mac: client.mac,
                };
                await clientStateFlow.trigger(this, tokens, {
                  status: 'offline',
                  client: tokens,
                });
              }
            }
          }

          // Update device capabilities with retrieved information
          await this.setCapabilityValue(
            'measure_cpu_usage',
            this.savedCpuUsage,
          ).catch(this.error);
          await this.setCapabilityValue(
            'measure_mem_usage',
            this.savedMemUsage,
          ).catch(this.error);
          const ipInfo = wlanResponse?.result?.wan?.ip_info;
          if (ipInfo && ipInfo.ip) {
            await this.setCapabilityValue('wan_ipv4_ipaddr', ipInfo.ip).catch(
              this.error,
            );
          } else {
            this.error('IP information or IP address not available');
          }
          if (this.homey.settings.get('debugenabled')) {
            this.homey.app.log(
              `${settings.hostname} Timer: onInit(): wlanResponse result:`,
              JSON.stringify(wlanResponse.result, null, 2),
            );
            this.homey.app.log(
              `${settings.hostname} Timer: onInit():wan_ipv4_ipaddr: `,
              wlanResponse.result.wan.ip_info.ip,
            );
          }
          await this.setCapabilityValue('device_role', settings.role).catch(
            this.error,
          );
          await this.setCapabilityValue(
            'lan_ipv4_ipaddr',
            settings.hostname,
          ).catch(this.error);
          await this.setCapabilityValue(
            'connected_clients',
            clientList.result.client_list.length,
          ).catch(this.error);

          // Calculate total download and upload speeds
          let totalDownKiloBytesPerSecond = 0;
          let totalUpKiloBytesPerSecond = 0;

          for (const client of clientList.result.client_list) {
            totalDownKiloBytesPerSecond += client.down_speed;
            totalUpKiloBytesPerSecond += client.up_speed;
          }

          this.log(`Total Download Speed: ${totalDownKiloBytesPerSecond} KB/s`);
          this.log(`Total Upload Speed: ${totalUpKiloBytesPerSecond} KB/s`);
          this.savedDownKiloBytesPerSecond = totalDownKiloBytesPerSecond;
          this.savedUpKiloBytesPerSecond = totalUpKiloBytesPerSecond;
          await this.setCapabilityValue(
            'measure_down_kilo_bytes_per_second',
            totalDownKiloBytesPerSecond,
          ).catch(this.error);
          await this.setCapabilityValue(
            'measure_up_kilo_bytes_per_second',
            totalUpKiloBytesPerSecond,
          ).catch(this.error);

          // Update WAN alarm status
          this.savedWanState =
            internetResponse.result.ipv4.inet_status !== 'online';
          await this.setCapabilityValue(
            'alarm_wan_state',
            this.savedWanState,
          ).catch(this.error);

          // Register capability listeners for reboot, CPU usage, and memory usage
          this.registerCapabilityListener('reboot', async (value) => {
            if (Boolean(value)) {
              this.log(`Reboot triggered: ${Boolean(value)}`);
              this.log(`mac: ${devicedata.id}`);
              const rebooted = await this.api
                .reboot(devicedata.id)
                .catch(this.error);
              if (rebooted) {
                setTimeout(async () => {
                  await this.setCapabilityValue('reboot', false).catch(
                    this.error,
                  );
                }, 60000); // 60 seconds
              } else {
                this.error('Failed to reboot');
              }
            }
          });

          this.registerCapabilityListener(
            'measure_cpu_usage',
            async (value) => {
              this.savedCpuUsage = value;
              this.log(`CPU Usage: ${value}`);
            },
          );

          this.registerCapabilityListener(
            'measure_mem_usage',
            async (value) => {
              this.savedMemUsage = value;
              this.log(`Memory Usage: ${value}`);
            },
          );

          const clientIsConnected =
            this.homey.flow.getConditionCard('client_is_online');
          clientIsConnected.registerRunListener(async (args) => {
            if (this.clients.find((client) => client.mac === args.client.mac)) {
              return true;
            }
            return false;
          });
          clientIsConnected.registerArgumentAutocompleteListener(
            'client',
            async (query) => {
              const filteredClients = this.clients.filter((client) => {
                const search = query.toLowerCase();

                return (
                  client.mac.toLowerCase().includes(search) ||
                  client.name.toLowerCase().includes(search) ||
                  client.ipaddr.toLowerCase().includes(search)
                );
              });
              const results = [
                ...filteredClients.map((client) => ({
                  name: client.name,
                  mac: client.mac,
                  description: client.mac,
                })),
              ];

              return results;
            },
          );

          clientStateFlow.registerRunListener(async (args, state) => {
            this.log('clientStateFlow.registerRunListener', {
              args,
              state,
            });
            return (
              args.status === state.status &&
              args.client.mac === state.client.mac
            );
          });
          clientStateFlow.registerArgumentAutocompleteListener(
            'client',
            async (query) => {
              const filteredClients = this.clients.filter((client) => {
                const search = query.toLowerCase();

                return (
                  client.mac.toLowerCase().includes(search) ||
                  client.name.toLowerCase().includes(search) ||
                  client.ipaddr.toLowerCase().includes(search)
                );
              });
              const results = [
                ...filteredClients.map((client) => ({
                  name: client.name,
                  mac: client.mac,
                  description: client.mac,
                })),
              ];

              return results;
            },
          );
          // Set up an interval to periodically update device metrics
          this.timeoutSecondsIntervalId = setInterval(async () => {
            this.log('Running interval', settings.timeoutSeconds * 1000);
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `Setting interval for device ${this.getName()} (${
                  this.getData().id
                }) with IP ${settings.hostname} with intervall id: ${
                  this.timeoutSecondsIntervalId
                }`,
              );

              this.homey.app.log(
                `${settings.hostname} Timer api: `,
                JSON.stringify(this.api, null, 2),
              );
            }
            // Retrieve updated performance metrics from the API
            const performance = (await this.api.performance().catch((e) => {
              this.error('Failed to retrieve performance data', e);
              this.homey.app.error(
                'Timer: Failed to retrieve performance data',
                e,
              );
              return { error_code: 1, result: { cpu_usage: 0, mem_usage: 0 } }; // Return default values in case of error
            })) as PerformanceResponse;
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `${settings.hostname} Timer: onInit():performance: `,
                JSON.stringify(performance, null, 2),
              );
            }
            const resultCpuUsage = Math.round(
              Number(performance.result.cpu_usage) * 100,
            );
            const resultMemUsage = Math.round(
              Number(performance.result.mem_usage) * 100,
            );
            const wlanResponse = (await this.api.getWAN().catch((e) => {
              this.error('Failed to retrieve WAN data', e);
              this.homey.app.error('Timer: Failed to retrieve WAN data', e);
              return { error_code: 1, result: {} }; // Return default values in case of error
            })) as WANResponse;
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `${settings.hostname} Timer: onInit():wlanResponse: `,
                JSON.stringify(wlanResponse, null, 2),
              );
            }

            let clientList = (await this.api.clientList().catch((e) => {
              this.error('Failed to retrieve client list', e);
              this.homey.app.error('Timer: Failed to retrieve client list', e);
              return {
                error_code: 1,
                result: {
                  client_list: [],
                },
              }; // Return default values in case of error
            })) as ClientListResponse;
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `${settings.hostname} Timer: onInit():clientList: `,
                JSON.stringify(clientList, null, 2),
              );

              this.log(
                'clientList.length: ',
                clientList.result.client_list.length,
              );
            }
            const lastClients = this.clients;
            this.log('lastClients.length: ', lastClients.length);
            this.clients = clientList.result.client_list;
            this.log('this.clients.length: ', this.clients.length);
            for (const client of this.clients) {
              if (lastClients.length > 0) {
                if (
                  !lastClients.find((obj) => {
                    return obj.mac === client.mac;
                  })
                ) {
                  const tokens = {
                    name: client.name,
                    ipaddr: client.ip,
                    mac: client.mac,
                  };
                  await clientStateFlow
                    .trigger(this, tokens, {
                      status: 'online',
                      client: tokens,
                    })
                    .catch(this.error);
                  this.log(`client ${tokens.name} is online`);
                }
              }
            }
            if (lastClients.length > 0) {
              for (const client of lastClients) {
                if (
                  !this.clients.find((obj) => {
                    return obj.mac === client.mac;
                  })
                ) {
                  const tokens = {
                    name: client.name,
                    ipaddr: client.ip,
                    mac: client.mac,
                  };
                  await clientStateFlow
                    .trigger(this, tokens, {
                      status: 'offline',
                      client: tokens,
                    })
                    .catch(this.error);
                  this.log(`client ${tokens.name} is offline`);
                }
              }
            }

            // Update device capabilities with retrieved information
            await this.setCapabilityValue(
              'measure_cpu_usage',
              resultCpuUsage,
            ).catch(this.error);
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `${settings.hostname} Timer: onInit():measure_cpu_usage: `,
                resultCpuUsage,
              );
            }
            await this.setCapabilityValue(
              'measure_mem_usage',
              resultMemUsage,
            ).catch(this.error);
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `${settings.hostname} Timer: onInit():measure_mem_usage: `,
                resultMemUsage,
              );
            }
            const ipInfo = wlanResponse?.result?.wan?.ip_info;
            if (ipInfo && ipInfo.ip) {
              await this.setCapabilityValue('wan_ipv4_ipaddr', ipInfo.ip).catch(
                this.error,
              );
            } else {
              this.error('IP information or IP address not available');
            }
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `${settings.hostname} Timer: onInit(): wlanResponse result:`,
                JSON.stringify(wlanResponse.result, null, 2),
              );
              this.homey.app.log(
                `${settings.hostname} Timer: onInit():wan_ipv4_ipaddr: `,
                wlanResponse.result.wan.ip_info.ip,
              );
            }
            await this.setCapabilityValue('device_role', settings.role).catch(
              this.error,
            );
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `${settings.hostname} Timer: onInit():device_role: `,
                settings.role,
              );
            }
            await this.setCapabilityValue(
              'lan_ipv4_ipaddr',
              settings.hostname,
            ).catch(this.error);
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `${settings.hostname} Timer: onInit():lan_ipv4_ipaddr: `,
                settings.hostname,
              );
            }
            await this.setCapabilityValue(
              'connected_clients',
              clientList.result.client_list.length,
            ).catch(this.error);
            if (this.homey.settings.get('debugenabled')) {
              this.homey.app.log(
                `${settings.hostname} Timer: onInit():connected_clients: `,
                clientList.result.client_list.length,
              );
            }

            // Calculate total download and upload speeds
            let totalDownKiloBytesPerSecond = 0;
            let totalUpKiloBytesPerSecond = 0;
            for (const client of clientList.result.client_list) {
              totalDownKiloBytesPerSecond += client.down_speed;
              totalUpKiloBytesPerSecond += client.up_speed;
            }
            this.log(
              `Total Download Speed: ${totalDownKiloBytesPerSecond} KB/s`,
            );
            this.log(`Total Upload Speed: ${totalUpKiloBytesPerSecond} KB/s`);
            await this.setCapabilityValue(
              'measure_down_kilo_bytes_per_second',
              totalDownKiloBytesPerSecond,
            ).catch(this.error);
            await this.setCapabilityValue(
              'measure_up_kilo_bytes_per_second',
              totalUpKiloBytesPerSecond,
            ).catch(this.error);

            // Trigger flow cards if CPU or memory usage has changed
            if (resultCpuUsage !== this.savedCpuUsage) {
              const cardTriggerCpuUsage =
                this.homey.flow.getDeviceTriggerCard('cpu_usage');
              cardTriggerCpuUsage
                .trigger(this, {
                  device: settings.hostname,
                  cpu_usage: resultCpuUsage,
                })
                .catch((err) => {
                  this.error(
                    `Failed to trigger: ${cardTriggerCpuUsage.id} `,
                    err,
                  );
                });
              this.savedCpuUsage = resultCpuUsage;
              this.log(`CPU Usage: ${resultCpuUsage}`);
            }

            if (resultMemUsage !== this.savedMemUsage) {
              const cardTriggerMemUsage =
                this.homey.flow.getDeviceTriggerCard('mem_usage');
              cardTriggerMemUsage
                .trigger(this, {
                  device: settings.hostname,
                  mem_usage: resultMemUsage,
                })
                .catch((err) => {
                  this.error(
                    `Failed to trigger: ${cardTriggerMemUsage.id} `,
                    err,
                  );
                });
              this.savedMemUsage = resultMemUsage;
              this.log(`Memory Usage: ${resultMemUsage}`);

              // Update WAN status if it has changed
              const currentWANStatus =
                internetResponse.result.ipv4.inet_status !== 'online';
              this.log(
                `Current WAN status: ${internetResponse.result.ipv4.inet_status}`,
              );
              this.log(`Computed alarm status: ${currentWANStatus}`);
              if (currentWANStatus !== this.savedWanState) {
                this.log(
                  `WAN alarm status changed from ${this.savedWanState} to ${currentWANStatus}`,
                );
                const cardTriggerWanStatus = this.homey.flow.getTriggerCard(
                  'alarm_wan_state_changed',
                );
                cardTriggerWanStatus
                  .trigger({
                    device: settings.hostname,
                    wan_state: currentWANStatus,
                  })
                  .catch((err) => {
                    this.error(
                      `Failed to trigger: ${cardTriggerWanStatus.id} `,
                      err,
                    );
                  });

                this.savedWanState = currentWANStatus;
              } else {
                this.log('WAN alarm status remains unchanged.');
              }

              await this.setCapabilityValue(
                'alarm_wan_state',
                currentWANStatus,
              ).catch(this.error);
            }
          }, 15 * 1000 + Math.random() * 10);
        } else {
          this.error('Current device not found in the device list');
        }
      } else {
        this.error('Failed to retrieve device information');
      }
    } catch (error) {
      this.error('Failed to initialize device', error);
    }
  }

  /**
   * Handles updates to the device settings.
   * Reinitializes the API connection if relevant settings are changed.
   * @param oldSettings - The old settings before the change.
   * @param newSettings - The new settings after the change.
   * @param changedKeys - The keys that were changed.
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: {
      [key: string]: string | number | boolean | null | undefined;
    };
    newSettings: {
      [key: string]: string | number | boolean | null | undefined;
    };
    changedKeys: string[];
  }): Promise<void> {
    this.log('Device settings updated:', {
      oldSettings,
      newSettings,
      changedKeys,
    });

    // Reinitialize API if hostname or password has changed
    if (changedKeys.includes('hostname') || changedKeys.includes('password')) {
      try {
        this.log('API reinitialized with updated settings');
      } catch (error) {
        this.error('Failed to reinitialize API', error);
      }
    }
  }

  /**
   * onDeleted is called when the user deletes the device.
   * This method ensures that any active intervals are cleared to prevent continued operations.
   */
  async onDeleted(): Promise<void> {
    this.log('TplinkDecoDevice has been deleted');

    // Clear the first interval if it's active
    if (this.timeoutSecondsIntervalId) {
      clearInterval(this.timeoutSecondsIntervalId);
      this.log('timeoutSecondsIntervalId cleared'); // Log clearing of the interval
      this.timeoutSecondsIntervalId = null; // Reset the interval ID
    }
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
}

module.exports = TplinkDecoDevice;
