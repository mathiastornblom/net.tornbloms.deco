import { generateRsaKey, encryptRsa } from '././utils/rsa';
import {
  AESKey,
  generateAESKey,
  AES128Encrypt,
  AES128Decrypt,
} from '././utils/aes';
import { AxiosInstance } from 'axios';
import { KeyObject } from 'crypto';
import { url } from 'inspector';

// Buffer for the default body used in read operations
const readBody = Buffer.from(JSON.stringify({ operation: 'read' }));

// Interface for the structure of the password key response
interface PasswordKeyResponse {
  result: {
    username: string;
    password: string[];
  };
  error_code: number;
}

// Interface for the structure of the session key response
interface SessionKeyResponse {
  result: {
    seq: number;
    key: string[];
  };
  error_code: number;
}

// Interface for the structure of the response data
interface ResponseData {
  data: string;
}

// Interface for endpoint arguments
interface EndpointArgs {
  form: string;
}

// Deco class handles encryption, decryption, and communication with the server
export default class Deco {
  private aes: AESKey;
  private hash: string;
  private rsa: KeyObject;
  private sequence: number;
  private c: AxiosInstance;

  // Constructor initializes the Deco instance with necessary encryption keys and HTTP client
  constructor(
    aes: AESKey,
    hash: string,
    rsa: KeyObject,
    sequence: number,
    httpClient: AxiosInstance,
  ) {
    this.aes = aes;
    this.hash = hash;
    this.rsa = rsa;
    this.sequence = sequence;
    this.c = httpClient;
    // console.log('Deco instance initialized with AES, RSA, and HTTP client.');
  }

  // Static method to generate a new AES key
  public static generateAESKey(): AESKey {
    // console.log('Generating AES key...');
    return generateAESKey();
  }

  // Method to retrieve the password key from the server and generate an RSA key from it
  public async getPasswordKey(): Promise<KeyObject | null> {
    const args: EndpointArgs = { form: 'keys' };
    // console.log('getPasswordKey: Starting password key retrieval.');
    try {
      const passKey: PasswordKeyResponse = await this.doPost(
        ';stok=/login',
        args,
        readBody,
      );
      // console.log('getPasswordKey: Received password key response:', passKey);

      if (passKey.error_code !== 0) {
        throw new Error(`Error fetching password key: ${passKey.error_code}`);
      }

      const key = generateRsaKey(passKey.result.password);
      // console.log('getPasswordKey: Generated RSA public key:', key);

      return key;
    } catch (e) {
      // console.log('getPasswordKey: Error generating RSA key:', e);
      return null;
    }
  }

  // Method to retrieve the session key from the server and generate an RSA key from it
  public async getSessionKey(): Promise<{
    key: KeyObject | null;
    seq: number;
  }> {
    const args: EndpointArgs = { form: 'auth' };
    // console.log('getSessionKey: Starting session key retrieval.');
    try {
      const passKey: SessionKeyResponse = await this.doPost(
        ';stok=/login',
        args,
        readBody,
      );
      // console.log('getSessionKey: Received session key response: ', passKey);

      if (passKey.error_code !== 0) {
        throw new Error(`Error fetching session key: ${passKey.error_code}`);
      }

      const key = generateRsaKey(passKey.result.key);
      // console.log('getSessionKey: Error generating RSA key:', key);

      return { key, seq: passKey.result.seq };
    } catch (e) {
      // console.log('getSessionKey: Failed to get session key:', e);
      return { key: null, seq: 0 };
    }
  }

  // Method to send an encrypted POST request to the server
  public async doEncryptedPost(
    path: string,
    params: EndpointArgs,
    body: Buffer,
    isLogin: boolean,
    key: KeyObject = this.rsa,
    sequence: number = this.sequence,
  ): Promise<any> {
    // console.log('Starting encrypted POST request...');

    // Check and log the RSA key
    // console.log('Checking RSA key before encryption:', key);

    if (!key) {
      // console.log('RSA key is missing or undefined before encryption.');
      throw new Error('RSA key is missing or undefined.');
    }

    try {
      // Encrypt the data using AES
      var encryptedData = AES128Encrypt(body.toString(), this.aes);
      // console.log('Data encrypted with AES:', encryptedData);

      const length = Number(sequence) + encryptedData.length;
      let sign: string;

      // Generate sign data depending on whether it's a login request or not
      if (isLogin) {
        sign = `k=${this.aes.key}&i=${this.aes.iv}&h=${this.hash}&s=${length}`;
        // console.log('doEncryptedPost: Generated login sign data:', sign);
      } else {
        sign = `h=${this.hash}&s=${length}`;
        // console.log('doEncryptedPost: Generated non-login sign data:', sign);
      }

      // Encrypt the sign data with RSA, possibly splitting it into two parts
      if (sign.length > 53) {
        const first = encryptRsa(sign.substring(0, 53), key);
        const second = encryptRsa(sign.substring(53), key);
        sign = `${first}${second}`;
        // console.log('Sign split into two encrypted parts.');
      } else {
        sign = encryptRsa(sign, key);
        // console.log('Sign encrypted as a single block.');
      }

      // Prepare the final POST data
      const postData = `sign=${encodeURIComponent(
        sign,
      )}&data=${encodeURIComponent(encryptedData)}`;
      // console.log('doEncryptedPost: Final POST data:', postData);

      // Convert postData to a Buffer and send it in the request
      const postDataBuffer = Buffer.from(postData);

      // Send the POST request with encrypted data
      const req: ResponseData = await this.doPost(path, params, postDataBuffer);
      // console.log('Encrypted POST request successful:', req);

      // Decrypt the response data
      const decoded = AES128Decrypt(req.data, this.aes);
      // console.log('doEncryptedPost: Decrypted response:', decoded);

      return JSON.parse(decoded);
    } catch (e) {
      // console.log('Error in doEncryptedPost:', e);
      throw e;
    }
  }

  // Method to send a POST request to the server
  public async doPost(
    path: string,
    params: EndpointArgs,
    body: Buffer,
  ): Promise<any> {
    // console.log(`Sending POST request to ${path} with params: ${params} and body params ${body}`,);

    // Configure the POST request
    const config = {
      method: 'POST',
      url: path,
      data: body,
      headers: {
        'Accept-Encoding': 'gzip',
        'Content-Type': 'application/json',
      },
      params: params, // Sending as a regular object
    };

    // Remove the 'Accept' header before sending the request
    this.c.interceptors.request.use((config) => {
      delete config.headers['Accept'];
      return config;
    });

    // Debugging raw body data before sending the request
    // console.log('URL:', url);
    // console.log('Query params:', params);
    // console.log('POST body:', body.toString());
    // console.log('Headers:', config);

    try {
      // Send the request and return the response data
      const response = await this.c(config);
      // console.log('doPost: Response status:', response.status);
      // console.log('doPost: Decoded response:', response.data);
      return response.data;
    } catch (e) {
      // console.log('Error in doPost:', e);
      throw e;
    }
  }
}
