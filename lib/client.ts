import crypto, { KeyObject } from 'crypto';
import axios, { AxiosInstance } from 'axios';
import Deco from './deco';
import { encryptRsa } from './utils/rsa';
import { AESKey, generateAESKey } from './utils/aes';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { debug } from 'debug';
const err = debug('app:error');
const log = debug('app:log');

// Define a constant for the username to be used for authentication
const userName = 'admin';

export interface ErrorResponse {
  errorcode: string;
  success: boolean;
}
// Interface to define the structure of the response for client list
export interface ClientListResponse {
  error_code: number;
  result: {
    client_list: Array<{
      access_host: string;
      client_mesh: boolean;
      client_type: string;
      connection_type: string;
      down_speed: number;
      enable_priority: boolean;
      interface: string;
      ip: string;
      mac: string;
      name: string;
      online: boolean;
      owner_id: string;
      remain_time: number;
      space_id: string;
      up_speed: number;
      wire_type: string;
    }>;
  };
}

export interface WLANNetworkResponse {
  error_code: number;
  result: {
    band5_1: {
      backhaul: {
        channel: number;
      };
      guest: {
        password: string;
        ssid: string;
        vlan_id: number;
        enable: boolean;
        need_set_vlan: boolean;
      };
      host: {
        password: string;
        ssid: string;
        channel: number;
        enable: boolean;
        mode: string;
        channel_width: string;
        enable_hide_ssid: boolean;
      };
    };
    is_eg: boolean;
    band2_4: {
      backhaul: {
        channel: number;
      };
      guest: {
        password: string;
        ssid: string;
        vlan_id: number;
        enable: boolean;
        need_set_vlan: boolean;
      };
      host: {
        password: string;
        ssid: string;
        channel: number;
        enable: boolean;
        mode: string;
        channel_width: string;
        enable_hide_ssid: boolean;
      };
    };
  };
}

export interface Band {
  backhaul: {
    channel: number;
  };
  guest: {
    password: string;
    ssid: string;
    vlan_id: number;
    enable: boolean;
    need_set_vlan: boolean;
  };
  host: {
    password: string;
    ssid: string;
    channel: number;
    enable: boolean;
    mode: string;
    channel_width: string;
    enable_hide_ssid: boolean;
  };
}

// Interface to define the structure of the response for WAN
export interface WANResponse {
  error_code: number;
  result: {
    wan: {
      ip_info: {
        mac: string;
        dns1: string;
        dns2: string;
        mask: string;
        gateway: string;
        ip: string;
      };
      dial_type: string;
      info: string;
      enable_auto_dns: boolean;
    };
    lan: {
      ip_info: {
        mac: string;
        mask: string;
        ip: string;
      };
    };
  };
}

// Interface to define the structure of the response for device list
export interface DeviceListResponse {
  error_code: number;
  result: {
    device_list: Array<{
      device_ip: string;
      device_id?: string;
      device_type: string;
      nand_flash: boolean;
      owner_transfer?: boolean;
      previous: string;
      bssid_5g: string;
      bssid_2g: string;
      bssid_sta_5g: string;
      bssid_sta_2g: string;
      parent_device_id?: string;
      software_ver: string;
      role: string;
      product_level: number;
      hardware_ver: string;
      inet_status: string;
      support_plc: boolean;
      mac: string;
      set_gateway_support: boolean;
      inet_error_msg: string;
      connection_type?: string[];
      custom_nickname?: string;
      nickname: string;
      group_status: string;
      oem_id: string;
      signal_level: {
        band2_4: string;
        band5: string;
      };
      device_model: string;
      oversized_firmware: boolean;
      speed_get_support?: boolean;
      hw_id: string;
    }>;
  };
}

export interface InternetResponse {
  error_code: number;
  result: {
    ipv6: {
      connect_type: string;
      auto_detect_type: string;
      error_code: number;
      inet_status: string;
      dial_status: string;
    };
    ipv4: {
      connect_type: string;
      auto_detect_type: string;
      error_code: number;
      dial_status: string;
      inet_status: string;
    };
    link_status: string;
  };
}

// Interface to define the structure of the response for advanced data
export interface AdvancedResponse {
  error_code: number;
  result: {
    support_dfs: boolean;
  };
}

// Interface to define the structure of the response for performance data
export interface PerformanceResponse {
  error_code: number;
  result: {
    cpu_usage: number;
    mem_usage: number;
  };
}

// Interface for the structure of login request
interface LoginRequest {
  params: {
    password: string;
  };
  operation: string;
}

// Interface for generic request parameters
interface RequestParams {
  operation?: string;
  params?: { [key: string]: any };
}

// Class to handle endpoint arguments and query parameters
class EndpointArgs {
  form: string;

  constructor(form: string) {
    this.form = form;
  }

  // Method to create URL search parameters
  queryParams(): URLSearchParams {
    const q = new URLSearchParams();
    q.append('form', this.form);
    return q;
  }
}

// Initialize a CookieJar instance for handling cookies in requests
const cookieJar = new CookieJar();
wrapper(axios);

// Main Client class to interact with the API
export default class DecoAPIWraper {
  public c: AxiosInstance;
  public aes: AESKey | undefined;
  public rsa: KeyObject | null = null;
  public hash: string = '';
  public stok: string = '';
  public sequence: number = 0;
  public host: string;
  public decoInstance: Deco | undefined;

  // Constructor to initialize the client with the target host
  constructor(target: string) {
    const baseUrl = `http://${target}/cgi-bin/luci/`;
    this.host = `${target}`;
    this.c = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
      withCredentials: true,
      jar: cookieJar,
    }) as AxiosInstance;
  }

  // Private method to ensure the Deco instance is initialized
  private ensureDecoInstance() {
    if (!this.decoInstance) {
      this.decoInstance = new Deco(
        this.aes!,
        this.hash,
        this.rsa!,
        this.sequence,
        this.c,
      );
      log(
        'client.ts: ' +
          'Deco instance initialized with AES, RSA, and HTTP client.',
      );
    }
  }
  // Method to ping the host
  private async pingHost(host: string): Promise<boolean> {
    try {
      const response = await this.c.get(`http://${host}`);
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  // Public method to authenticate the client with the given password
  public async authenticate(password: string): Promise<boolean> {
    log('client.ts: ' + 'Starting authentication process...');
    let authenticated = false;

    const hostIsAlive = await this.pingHost(this.host);
    try {
      if (!hostIsAlive) {
        throw new Error(`client.ts: Host ${this.host} is not reachable.`);
      }

      // Generate AES key for encryption
      this.aes = generateAESKey();
      log('client.ts: ' + `AES Key generated: ${this.aes.key.toString('hex')}`);
      log('client.ts: ' + `AES IV generated: ${this.aes.iv.toString('hex')}`);

      // Generate MD5 hash using the username and password
      this.hash = crypto
        .createHash('md5')
        .update(`${userName}${password}`)
        .digest('hex');
      log('client.ts: ' + `MD5 Hash generated: ${this.hash}`);

      this.ensureDecoInstance();

      log('client.ts: ' + 'Attempting to retrieve password key...');
      const passwordKey = await this.decoInstance!.getPasswordKey();
      if (!passwordKey) {
        throw new Error('client.ts: ' + 'Failed to retrieve password key.');
      }
      log('client.ts: ' + 'Password key retrieved successfully:', passwordKey);

      // Encrypt the password using the retrieved password key
      log('client.ts: ' + 'Encrypting password using password key...');
      const encryptedPassword = encryptRsa(password, passwordKey!);
      log('client.ts: ' + `Encrypted password: ${encryptedPassword}`);

      log('client.ts: ' + 'Attempting to retrieve session key...');
      const { key: sessionKey, seq: sequence } =
        await this.decoInstance!.getSessionKey();
      if (!sessionKey) {
        throw new Error('client.ts: ' + 'Failed to retrieve session key.');
      }
      log(
        'client.ts: ' +
          `Session key retrieved successfully: ${printKey(
            sessionKey,
          )}), Sequence: ${sequence.toString()}`,
      );

      // Update RSA key and sequence
      this.rsa = sessionKey;
      this.sequence = sequence;

      // Additional Logging for Debugging
      log(
        'client.ts: ' + 'Checking RSA key after session key retrieval:',
        this.rsa,
      );

      // Continue with the login process...
      const loginReq: LoginRequest = {
        params: {
          password: encryptedPassword + '&confirm=true',
        },
        operation: 'login',
      };

      const loginJSON = JSON.stringify(loginReq);
      log('client.ts: ' + `Login request JSON: ${loginJSON}`);
      const args = new EndpointArgs('login');

      log('client.ts: ' + 'Sending login request...');
      try {
        const result = await this.decoInstance!.doEncryptedPost(
          ';stok=/login',
          args,
          Buffer.from(loginJSON),
          true,
          sessionKey,
          this.sequence,
        );

        this.stok = result.result.stok;
        if (!this.stok) {
          throw new Error('client.ts: ' + 'Failed to retrieve STok.');
        } else {
          log('client.ts: ' + `Login successful. STOK: ${this.stok}`);
          authenticated = true;
        }
      } catch (e) {
        log('client.ts: ' + e);
        return authenticated;
      }
      return authenticated;
    } catch {
      return authenticated;
    }
  }

  // Public method to retrieve Wan data
  async getAdvancedSettings(): Promise<AdvancedResponse | ErrorResponse> {
    log('client.ts: ' + 'Requesting advanced data...');
    const args = new EndpointArgs('power');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const response = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/wireless`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      response &&
      typeof response === 'object' &&
      'errorcode' in response &&
      'success' in response
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: response.errorcode,
        success: response.success,
      };
      err('client.ts: ' + 'Advanced request failed:', errorResponse);
      return errorResponse;
    }
    return response;
  }
  // Public method to retrieve Wan data
  async getWLAN(): Promise<WLANNetworkResponse | ErrorResponse> {
    log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('wlan');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const response = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/wireless`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      response &&
      typeof response === 'object' &&
      'errorcode' in response &&
      'success' in response
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: response.errorcode,
        success: response.success,
      };
      err('client.ts: ' + 'WLAN request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    const decodeBase64 = (encoded: string): string => {
      try {
        return Buffer.from(encoded, 'base64').toString('utf-8');
      } catch (e) {
        err('client.ts: ' + `Failed to decode base64 string: ${encoded}`, e);
        return encoded; // Returnera den ursprungliga strängen om dekodning misslyckas
      }
    };

    // Dekodera band5_1
    response.result.band5_1.guest.ssid = decodeBase64(
      response.result.band5_1.guest.ssid,
    );
    response.result.band5_1.guest.password = decodeBase64(
      response.result.band5_1.guest.password,
    );
    response.result.band5_1.host.ssid = decodeBase64(
      response.result.band5_1.host.ssid,
    );
    response.result.band5_1.host.password = decodeBase64(
      response.result.band5_1.host.password,
    );

    // Dekodera band2_4
    response.result.band2_4.guest.ssid = decodeBase64(
      response.result.band2_4.guest.ssid,
    );
    response.result.band2_4.guest.password = decodeBase64(
      response.result.band2_4.guest.password,
    );
    response.result.band2_4.host.ssid = decodeBase64(
      response.result.band2_4.host.ssid,
    );
    response.result.band2_4.host.password = decodeBase64(
      response.result.band2_4.host.password,
    );

    log(
      'client.ts: ' + 'Processed WLAN network response: ',
      JSON.stringify(response),
    );

    return response;
  }

  // Public method to retrieve LAN data
  async getLAN(): Promise<any> {
    log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('lan_ip');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      err('client.ts: ' + 'LAN request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve Wan data
  async getWAN(): Promise<WANResponse | ErrorResponse> {
    log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('wan_ipv4');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      err('client.ts: ' + 'WAN request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }
  // Public method to retrieve Internt data
  async getInternet(): Promise<InternetResponse | ErrorResponse> {
    log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('internet');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      err('client.ts: ' + 'Internet request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve enviromet data
  async getModel(): Promise<any | ErrorResponse> {
    log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('model');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/device`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      err('client.ts: ' + 'Model request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve enviromet data
  async getEnviroment(): Promise<any | ErrorResponse> {
    log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('envar');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/system`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      err('client.ts: ' + 'Enviromet request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }
  // Public method to retrieve status data
  async getStatus(): Promise<any | ErrorResponse> {
    log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('all');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/status`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      err('client.ts: ' + 'Status request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve firmware data
  async firmware(): Promise<any | ErrorResponse> {
    log('client.ts: ' + 'Requesting firmware data...');
    const args = new EndpointArgs('upgrade');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/firmware`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      err('client.ts: ' + 'Firmware request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve performance data
  async performance(): Promise<PerformanceResponse | ErrorResponse> {
    log('client.ts: ' + 'Requesting performance data...');
    const args = new EndpointArgs('performance');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as PerformanceResponse;

    // Check if result is an error
    if (isErrorResponse(result)) {
      err('client.ts: ' + 'Performance request failed:', result);
      return result;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve the list of devices
  async deviceList(): Promise<DeviceListResponse | ErrorResponse> {
    log('client.ts: ' + 'Requesting device list...');
    const args = new EndpointArgs('device_list');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/device`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as DeviceListResponse;

    // Check if result is an error
    if (isErrorResponse(result)) {
      err('client.ts: ' + 'device list request failed:', result);
      return result;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve the list of clients
  async clientList(): Promise<ClientListResponse | ErrorResponse> {
    log('client.ts: ' + 'Requesting client list...');
    const args = new EndpointArgs('client_list');
    const request: RequestParams = {
      operation: 'read',
      params: { device_mac: 'default' },
    };

    const jsonRequest = JSON.stringify(request);
    log('client.ts: ' + `Client list request JSON: ${jsonRequest}`);
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/client`,
      args,
      Buffer.from(jsonRequest),
      false,
    )) as ClientListResponse;

    // Check if result is an error
    if (isErrorResponse(result)) {
      err('client.ts: ' + 'client list request failed:', result);
      return result;
    }

    log('client.ts: ' + 'Processing client list response...');

    // Uppdatera client_list med dekodade namn
    result.result.client_list.forEach((client) => {
      try {
        // Försök att dekoda namnet
        const decodedName = Buffer.from(client.name, 'base64').toString(
          'utf-8',
        );
        log('client.ts: ' + `Decoded client name: ${decodedName}`);

        // Sätt det dekodade namnet till klienten
        client.name = decodedName;
      } catch (e) {
        // Logga fel om dekodningen misslyckas
        err('client.ts: ' + `Failed to decode client name: ${client.name}`, e);
      }
    });
    log(
      'client.ts: ' + 'Processed client list response: ',
      JSON.stringify(result),
    );
    // Returnera det uppdaterade resultatet
    return result;
  }

  // Public method to reboot devices based on their MAC addresses
  async reboot(...macAddrs: string[]): Promise<{ [key: string]: any }> {
    log(
      'client.ts: ' +
        `Requesting reboot for MAC addresses: ${macAddrs.join(', ')}`,
    );
    const macList = macAddrs.map((mac) => ({ mac: mac.toUpperCase() }));
    const request: RequestParams = {
      operation: 'reboot',
      params: {
        mac_list: macList,
      },
    };

    const jsonRequest = JSON.stringify(request);
    log('client.ts: ' + `Reboot request JSON: ${jsonRequest}`);
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );

    const args = new EndpointArgs('system');
    return (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/device`,
      args,
      Buffer.from(jsonRequest),
      false,
    )) as { [key: string]: any };
  }

  // Public method to send a custom request to a specific endpoint
  async custom(
    path: string,
    params: EndpointArgs,
    body: Buffer,
  ): Promise<any | ErrorResponse> {
    log('client.ts: ' + `Sending custom request to path: ${path}`);
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}${path}`,
      params,
      body,
      false,
    )) as any;

    // Check if result is an error
    if (isErrorResponse(result)) {
      err('client.ts: ' + 'client list request failed:', result);
      return result;
    }
    return result;
  }
}

// Function to extract and print details from an RSA KeyObject
function printKey(keyObject: KeyObject): string {
  // Export the key as a DER-encoded buffer
  const keyBuffer = keyObject.export({ type: 'pkcs1', format: 'der' });

  // The modulus for RSA keys is stored in the first part of the key structure
  // Parse the modulus by skipping the header bytes in the DER-encoded key
  const modulusOffset = 29; // Skip the header bytes (this offset can vary slightly)
  const modulusLength = keyBuffer.readUInt16BE(modulusOffset - 2); // Read the modulus length

  // Extract the modulus
  const modulus = keyBuffer.slice(modulusOffset, modulusOffset + modulusLength);

  return (
    'Modulus (hex): ' +
    modulus.toString('hex') +
    'Exponent: ' +
    keyObject.asymmetricKeyDetails?.publicExponent
  );
}

// Type guard för att kontrollera om ett objekt är av typen ErrorResponse
function isErrorResponse(result: any): result is ErrorResponse {
  return (
    typeof result === 'object' &&
    result !== null &&
    'errorcode' in result &&
    'success' in result &&
    typeof result.errorcode === 'string' &&
    typeof result.success === 'boolean'
  );
}
