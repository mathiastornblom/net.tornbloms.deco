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
 * Class representing a TP-Link Deco Device in Homey.
 * Manages initialization, settings updates, and device-specific actions.
 */
class TplinkDecoDevice extends Device {
  // Indicates if debug mode is enabled
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;

  // Variables to store previous state values
  private savedCpuUsage = 0;
  private savedMemUsage = 0;
  private savedWanipv4State = false;
  private savedWanipv6State = false;

  // Interval ID for periodic updates
  private timeoutSecondsIntervalId: ReturnType<typeof setInterval> | null =
    null;
  private api: decoapiwrapper | any;

  connected = false; // Connection status
  clients: any[] = []; // List of connected clients

  // Buffer for read operations
  readBody = Buffer.from('{"operation": "read"}');

  /**
   * Initializes the TP-Link Deco device.
   * Sets up the API connection using device settings and starts periodic updates.
   */
  async onInit() {
    try {
      // Log device initialization
      this.homey.app.log(
        `Device instance: ${this.getName()} (${this.getData().id})`,
      );
      this.log(`TP-Link Deco Device initialized: ${this.getName()}`);

      // Retrieve device data
      const devicedata = this.getData();

      // Retrieve device settings
      const settings = this.getSettings();
      this.debug(`Settings:`, settings);

      if (this.hasCapability('wan_ipv4_ipaddr') && settings.role === 'slave') {
        await this.removeCapability('wan_ipv4_ipaddr');
      }
      if (
        !this.hasCapability('wan_ipv4_ipaddr') &&
        settings.role === 'master'
      ) {
        await this.addCapability('wan_ipv4_ipaddr');
      }
      if (this.hasCapability('alarm_wan_ipv6_state')) {
        this.removeCapability('alarm_wan_ipv6_state');
      }

      // Check if hostname and password are provided
      if (settings.hostname && settings.password) {
        // Instantiate the API wrapper with the device hostname
        this.api = new decoapiwrapper(settings.hostname);

        // Authenticate with the API
        this.connected = await this.api
          .authenticate(settings.password)
          .catch((e) => {
            this.error('Failed to authenticate', e);
            return false;
          });

        if (!this.connected) {
          this.error('Authentication failed');
          return;
        }

        this.log('Successfully connected to TP-Link Deco');

        // Register capability listeners for reboot, CPU usage, and memory usage
        this.registerCapabilityListener('reboot', async (value) => {
          if (Boolean(value)) {
            this.log(`Reboot triggered: ${Boolean(value)}`);
            this.log(`mac: ${devicedata.id}`);
            const rebooted = await this.api
              .reboot(devicedata.id)
              .catch(this.error);
            if (rebooted) {
              await this.setUnavailable(
                this.homey.__('flow.reboot_deco.message'),
              );
              setTimeout(async () => {
                await this.setAvailable();
                await this.setCapabilityValue('reboot', false).catch(
                  this.error,
                );
              }, 60000); // 60 seconds
            } else {
              this.error('Failed to reboot');
            }
          }
        });

        this.registerCapabilityListener('measure_cpu_usage', async (value) => {
          this.savedCpuUsage = value;
          this.log(`CPU Usage: ${value}`);
        });

        this.registerCapabilityListener('measure_mem_usage', async (value) => {
          this.savedMemUsage = value;
          this.log(`Memory Usage: ${value}`);
        });

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
                Buffer.from(client.name, 'base64')
                  .toString()
                  .toLowerCase()
                  .includes(search) ||
                client.ipaddr.toLowerCase().includes(search)
              );
            });
            const results = [
              ...filteredClients.map((client) => ({
                name: Buffer.from(client.name, 'base64').toString(),
                mac: client.mac,
                description: client.mac,
              })),
            ];

            return results;
          },
        );

        const clientStateFlow = this.homey.flow.getDeviceTriggerCard(
          'client_state_changed',
        );
        clientStateFlow.registerRunListener(async (args, state) => {
          this.log('clientStateFlow.registerRunListener', {
            args,
            state,
          });
          return (
            args.status === state.status && args.client.mac === state.client.mac
          );
        });
        clientStateFlow.registerArgumentAutocompleteListener(
          'client',
          async (query) => {
            const filteredClients = this.clients.filter((client) => {
              const search = query.toLowerCase();

              return (
                client.mac.toLowerCase().includes(search) ||
                Buffer.from(client.name, 'base64')
                  .toString()
                  .toLowerCase()
                  .includes(search) ||
                client.ipaddr.toLowerCase().includes(search)
              );
            });
            const results = [
              ...filteredClients.map((client) => ({
                name: Buffer.from(client.name, 'base64').toString(),
                mac: client.mac,
                description: client.mac,
              })),
            ];

            return results;
          },
        );

        // Initialize capabilities on device start
        await this.updateDeviceMetrics();

        // Set up an interval to periodically update device metrics using timeoutSeconds from settings
        const interval = (settings.timeoutSeconds || 15) * 1000; // Default to 15 seconds if not set
        this.setUpdateInterval(interval);
      } else {
        this.error('Missing API configuration settings');
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
    oldSettings: { [key: string]: any };
    newSettings: { [key: string]: any };
    changedKeys: string[];
  }): Promise<void> {
    this.log('Device settings updated:', {
      oldSettings,
      newSettings,
      changedKeys,
    });

    // Update debug mode if changed
    if (changedKeys.includes('debugenabled')) {
      this.debugEnabled = newSettings.debugenabled === 'true';
    }

    // Reinitialize API if hostname or password has changed
    if (changedKeys.includes('hostname') || changedKeys.includes('password')) {
      try {
        this.api = new decoapiwrapper(newSettings.hostname);
        this.connected = await this.api.authenticate(newSettings.password);
        this.log('API reinitialized with updated settings');
      } catch (error) {
        this.error('Failed to reinitialize API', error);
      }
    }

    // Update the interval if timeoutSeconds has changed
    if (changedKeys.includes('timeoutSeconds')) {
      const interval = (newSettings.timeoutSeconds || 15) * 1000; // Default to 15 seconds if not set
      this.setUpdateInterval(interval);
      this.log(
        `Update interval changed to ${newSettings.timeoutSeconds} seconds`,
      );
    }
  }

  /**
   * Called when the device is deleted.
   * Ensures that any active intervals are cleared to prevent continued operations.
   */
  async onDeleted(): Promise<void> {
    this.log('TplinkDecoDevice has been deleted');

    // Clear the interval if it's active
    if (this.timeoutSecondsIntervalId) {
      clearInterval(this.timeoutSecondsIntervalId);
      this.log('Cleared interval for device metrics update');
      this.timeoutSecondsIntervalId = null;
    }
  }

  /**
   * Sets up or updates the interval for updating device metrics.
   * @param interval - The interval in milliseconds.
   */
  private setUpdateInterval(interval: number) {
    // Clear any existing interval
    if (this.timeoutSecondsIntervalId) {
      clearInterval(this.timeoutSecondsIntervalId);
      this.timeoutSecondsIntervalId = null;
    }

    // Set up a new interval
    this.timeoutSecondsIntervalId = setInterval(
      this.updateDeviceMetrics.bind(this),
      interval + Math.random() * 10,
    );
    this.log(`Set update interval to ${interval / 1000} seconds`);
  }

  /**
   * Updates device metrics by fetching data from the API and updating capabilities.
   * Handles performance metrics, WAN IP address, internet status, client list, and client state changes.
   */
  private async updateDeviceMetrics() {
    try {
      const settings = this.getSettings();
      const devicedata = this.getData();

      // Retrieve device list from the API
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
      this.debug(`${settings.hostname} onInit():deviceList: `, deviceList);

      if (
        deviceList.error_code === 0 &&
        deviceList.result.device_list.length > 0
      ) {
        // Filter the device list to find the current device
        const device = deviceList.result.device_list.find(
          (d) => d.mac === devicedata.id,
        );

        this.debug(`${settings.hostname} onInit():Filtered device: `, device);

        if (device) {
          // Update device settings with retrieved information
          await this.setSettings({
            hardware_ver: device.hardware_ver,
            software_ver: device.software_ver,
            role: device.role,
          });

          await this.updateCapability(
            'alarm_group_state',
            device.group_status.toLowerCase() !== 'connected',
          );
          await this.updateCapability('device_role', settings.role);
          await this.updateCapability('lan_ipv4_ipaddr', settings.hostname);

          // Fetch performance metrics
          const performance = await this.safeApiCall(
            () =>
              this.api.custom(
                '/admin/network',
                { form: 'performance' },
                this.readBody,
              ),
            {
              error_code: 1,
              result: { cpu_usage: 0, mem_usage: 0 },
            },
            'Performance Metrics',
          );

          // Calculate CPU and memory usage percentages
          const resultCpuUsage = Math.round(
            Number(performance?.result?.cpu_usage ?? 0) * 100,
          );
          const resultMemUsage = Math.round(
            Number(performance?.result?.mem_usage ?? 0) * 100,
          );

          // Update device capabilities with retrieved performance information
          await this.updateCapability('measure_cpu_usage', resultCpuUsage);
          await this.updateCapability('measure_mem_usage', resultMemUsage);

          // Fetch WAN IP address
          if (device.role.toLowerCase() === 'master') {
            if (!this.hasCapability('wan_ipv4_ipaddr')) {
              await this.addCapability('wan_ipv4_ipaddr');
            }
            const wanResponse = await this.safeApiCall(
              () =>
                this.api.custom(
                  '/admin/network',
                  { form: 'wan_ipv4' },
                  this.readBody,
                ),
              {
                error_code: 1,
                result: {
                  lan: {
                    ip_info: {
                      ip: '',
                      mac: '',
                      mask: '',
                    },
                  },
                  wan: {
                    dial_type: '',
                    enable_auto_dns: '',
                    info: {},
                    ip_info: {
                      dns1: '',
                      dns2: '',
                      gateway: '',
                      ip: '',
                      mac: '',
                      mask: '',
                    },
                  },
                },
              },
              'WAN IPv4 Data',
            );

            // Extract WAN IP address
            const wanIpAddress = wanResponse?.result?.wan?.ip_info?.ip ?? '';
            // Update capability with WAN IP address
            await this.updateCapability('wan_ipv4_ipaddr', wanIpAddress);
          }
          // Fetch Internet status
          const internetResponse = await this.safeApiCall(
            () =>
              this.api.custom(
                '/admin/network',
                { form: 'internet' },
                this.readBody,
              ),
            {
              error_code: 1,
              result: {
                ipv4: {
                  auto_detect_type: '',
                  connect_type: '',
                  dial_status: '',
                  error_code: 1,
                  inet_status: '',
                },
                ipv6: {
                  auto_detect_type: '',
                  connect_type: '',
                  dial_status: '',
                  error_code: 1,
                  inet_status: '',
                },
                link_status: '',
              },
            },
            'Internet Status',
          );

          // Handle WAN state changes for IPv4 and IPv6
          await this.handleWanStateChange(
            'ipv4',
            internetResponse?.result?.ipv4?.inet_status ?? '',
            this.savedWanipv4State ?? false,
            'alarm_wan_ipv4_state',
          );
          if (internetResponse?.result?.ipv6?.error_code === 0) {
            if (!this.hasCapability('alarm_wan_ipv6_state')) {
              await this.addCapability('alarm_wan_ipv6_state');
            }
            await this.handleWanStateChange(
              'ipv6',
              internetResponse?.result?.ipv6?.inet_status ?? '',
              this.savedWanipv6State ?? false,
              'alarm_wan_ipv6_state',
            );
          }

          // Fetch client list
          const request = {
            operation: 'read',
            params: {
              device_mac: 'default',
            },
          };
          const jsonRequest = JSON.stringify(request);
          const clientListResponse = await this.safeApiCall(
            () =>
              this.api.custom(
                '/admin/client',
                { form: 'client_list' },
                Buffer.from(jsonRequest),
              ),
            {
              error_code: 0,
              result: {
                client_list: [
                  {
                    access_host: '',
                    client_mesh: true,
                    client_type: '',
                    connection_type: '',
                    down_speed: 0,
                    enable_priority: false,
                    interface: '',
                    ip: '',
                    mac: '',
                    name: '',
                    online: true,
                    owner_id: '',
                    remain_time: 0,
                    space_id: '',
                    up_speed: 0,
                    wire_type: '',
                  },
                ],
              },
            },
            'Client List',
          );
          // let clientListResponse = (await this.api.clientList().catch((e) => {
          //   this.error('Failed to retrieve client list', e);
          //   this.homey.app.error('Failed to retrieve client list', e);
          //   return {
          //     error_code: 1,
          //     result: {
          //       client_list: [],
          //     },
          //   }; // Return default values in case of error
          // })) as ClientListResponse;

          const clientNames = clientListResponse.result.client_list
            .map((client) => atob(client.name))
            .join(', ');
          await this.setSettings({ clients: clientNames });

          const clientList = clientListResponse?.result?.client_list ?? [];
          // Update capability with the number of connected clients
          await this.updateCapability('connected_clients', clientList.length);

          // Handle client state changes
          await this.handleClientStateChanges(clientList);

          // Calculate total download and upload speeds
          const { totalDownKiloBytesPerSecond, totalUpKiloBytesPerSecond } =
            clientList.reduce(
              (totals, client) => {
                totals.totalDownKiloBytesPerSecond += client.down_speed ?? 0;
                totals.totalUpKiloBytesPerSecond += client.up_speed ?? 0;
                return totals;
              },
              { totalDownKiloBytesPerSecond: 0, totalUpKiloBytesPerSecond: 0 },
            );

          // Update capabilities with total download and upload speeds
          await this.updateCapability(
            'measure_down_kilo_bytes_per_second',
            totalDownKiloBytesPerSecond,
          );
          await this.updateCapability(
            'measure_up_kilo_bytes_per_second',
            totalUpKiloBytesPerSecond,
          );

          // Trigger flow cards if CPU or memory usage has changed
          await this.triggerUsageFlowCards(
            resultCpuUsage,
            resultMemUsage,
            settings.hostname,
          );
        }
      }
    } catch (error) {
      this.error('Failed to update device metrics', error);
    }
  }

  /**
   * Handles WAN state changes for IPv4 and IPv6.
   * Triggers flow cards if the WAN state has changed.
   * @param ipVersion - 'ipv4' or 'ipv6'.
   * @param inetStatus - The current internet status.
   * @param savedWanState - The previously saved WAN state.
   * @param capabilityName - The capability name to update.
   */
  private async handleWanStateChange(
    ipVersion: 'ipv4' | 'ipv6',
    inetStatus: string,
    savedWanState: boolean,
    capabilityName: string,
  ) {
    try {
      // Determine current WAN status
      const currentWanStatus = inetStatus?.toLowerCase() !== 'online';

      // Check if WAN status has changed
      if (currentWanStatus !== savedWanState) {
        const cardTriggerWanStatus = this.homey.flow.getTriggerCard(
          'alarm_wan_state_changed',
        );

        // Trigger flow card for WAN state change
        await cardTriggerWanStatus.trigger({
          device: this.getName() ?? 'Unknown Device',
          wan_state: currentWanStatus,
          ip_version: ipVersion,
        });

        // Update saved WAN state
        this[`savedWan${ipVersion}State`] = currentWanStatus;
      }

      // Update capability with current WAN status
      await this.updateCapability(capabilityName, currentWanStatus);
    } catch (err) {
      this.error(
        `Failed to handle WAN ${ipVersion} state change for device: ${
          this.getName() ?? 'Unknown Device'
        }`,
        err,
      );
    }
  }

  /**
   * Triggers flow cards for CPU and memory usage changes.
   * @param resultCpuUsage - The current CPU usage percentage.
   * @param resultMemUsage - The current memory usage percentage.
   * @param hostname - The hostname of the device.
   */
  private async triggerUsageFlowCards(
    resultCpuUsage: number,
    resultMemUsage: number,
    hostname: string,
  ) {
    try {
      // Trigger flow card for CPU usage change
      if (
        typeof resultCpuUsage === 'number' &&
        resultCpuUsage !== this.savedCpuUsage
      ) {
        const cardTriggerCpuUsage =
          this.homey.flow.getDeviceTriggerCard('cpu_usage');
        await cardTriggerCpuUsage.trigger(this, {
          device: hostname ?? 'Unknown Device',
          cpu_usage: resultCpuUsage,
        });
        // Update saved CPU usage
        this.savedCpuUsage = resultCpuUsage;
      }

      // Trigger flow card for memory usage change
      if (
        typeof resultMemUsage === 'number' &&
        resultMemUsage !== this.savedMemUsage
      ) {
        const cardTriggerMemUsage =
          this.homey.flow.getDeviceTriggerCard('mem_usage');
        await cardTriggerMemUsage.trigger(this, {
          device: hostname ?? 'Unknown Device',
          mem_usage: resultMemUsage,
        });
        // Update saved memory usage
        this.savedMemUsage = resultMemUsage;
      }
    } catch (err) {
      this.error('Failed to trigger usage flow cards', err);
    }
  }

  /**
   * Handles client state changes by comparing the current client list with the previous one.
   * Triggers flow cards when clients go online or offline.
   * @param clientList - The current list of clients.
   */
  private async handleClientStateChanges(clientList: any[]) {
    try {
      const clientStateFlow = this.homey.flow.getDeviceTriggerCard(
        'client_state_changed',
      );

      // Create Maps for quick lookup of clients by MAC address
      const lastClientsMap = new Map(
        this.clients?.map((client) => [client.mac, client]),
      );
      const currentClientsMap = new Map(
        clientList.map((client) => [client.mac, client]),
      );

      // Clients that have come online
      for (const [mac, client] of currentClientsMap) {
        if (!lastClientsMap.has(mac)) {
          const tokens = {
            name: Buffer.from(client.name, 'base64').toString(),
            ipaddr: client.ip,
            mac: client.mac,
            type: client.client_type,
          };
          await clientStateFlow.trigger(this, tokens, {
            status: 'online',
            client: tokens,
          });
        }
      }

      // Clients that have gone offline
      for (const [mac, client] of lastClientsMap) {
        if (!currentClientsMap.has(mac)) {
          const tokens = {
            name: Buffer.from(client.name, 'base64').toString(),
            ipaddr: client.ip,
            mac: client.mac,
            type: client.client_type,
          };
          await clientStateFlow.trigger(this, tokens, {
            status: 'offline',
            client: tokens,
          });
        }
      }

      // Update the stored clients for the next comparison
      this.clients = clientList;
    } catch (err) {
      this.error('Failed to handle client state changes', err);
    }
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

  /**
   * Updates a device capability with the provided value.
   * @param capability - The name of the capability to update.
   * @param value - The value to set for the capability.
   */
  private async updateCapability(capability: string, value: any) {
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.error(`Failed to update capability ${capability}`, err);
    }
  }

  /**
   * Logs debug messages if debug mode is enabled.
   * @param message - The debug message to log.
   * @param data - Optional data to log with the message.
   */
  private debug(message: string, data?: any) {
    if (this.debugEnabled) {
      if (data !== undefined) {
        this.log(`DEBUG: ${message}`, JSON.stringify(data, null, 2));
      } else {
        this.log(`DEBUG: ${message}`);
      }
    }
  }
}

module.exports = TplinkDecoDevice;
