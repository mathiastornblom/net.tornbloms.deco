import crypto, { createPublicKey, KeyObject } from 'crypto';
import * as asn1 from 'asn1.js';
import BN from 'bn.js';
import { debug } from 'debug';
const err = debug('app:error');
const log = debug('app:log');

// Define the ASN.1 structure for an RSA public key
const RSAPublicKeyASN = asn1.define('RSAPublicKey', function (this: any) {
  this.seq().obj(this.key('n').int(), this.key('e').int());
});

/**
 * Generates an RSA public key from provided modulus and exponent.
 *
 * @param data - An array where the first element is the modulus (hex) and the second is the exponent (hex).
 * @returns The generated RSA public key as a KeyObject or null if an error occurs.
 */
export function generateRsaKey(data: string[]): KeyObject | null {
  log('generateRsaKey: Starting RSA key generation.');
  log(`generateRsaKey: Modulus (hex): ${data[0]}`);
  log(`generateRsaKey: Exponent (hex): ${data[1]}`);

  // Convert the modulus and exponent from hex strings to BN (Big Number) objects
  const modulus = new BN(data[0], 16);
  const exponent = parseInt(data[1], 16);

  if (isNaN(exponent)) {
    err('generateRsaKey: Error parsing exponent.');
    return null;
  }

  // Encode the modulus and exponent into ASN.1 DER format
  const publicKeyDER = RSAPublicKeyASN.encode(
    {
      n: modulus,
      e: new BN(exponent),
    },
    'der',
  );

  // Create the RSA public key from the DER-encoded buffer
  const key = createPublicKey({
    key: publicKeyDER,
    format: 'der',
    type: 'pkcs1',
  });

  log(
    `generateRsaKey: Generated RSA Public Key (DER, hex):\n${key
      .export({ format: 'der', type: 'pkcs1' })
      .toString('hex')}`,
  );

  return key;
}

/**
 * Encrypts a message using the provided RSA public key.
 *
 * @param msg - The plaintext message to encrypt.
 * @param publicKey - The RSA public key used for encryption.
 * @returns The encrypted message as a hexadecimal string, or an empty string if an error occurs.
 */
export function encryptRsa(msg: string, publicKey: KeyObject): string {
  log('encryptRsa: Starting RSA encryption.');
  log(`encryptRsa: Message to encrypt: ${msg}`);
  log(
    `encryptRsa: Key: ${publicKey
      .export({ format: 'der', type: 'pkcs1' })
      .toString('hex')}`,
  );

  try {
    // Convert the message to a Buffer
    const messageBuffer = Buffer.from(msg, 'utf-8');

    // Determine the RSA key size in bits
    const keySize = publicKey.asymmetricKeyDetails?.modulusLength;
    if (!keySize) {
      throw new Error('Failed to determine RSA key size.');
    }

    // Encrypt the message using the RSA public key
    const cipher = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      messageBuffer,
    );

    // Convert the encrypted message to a hexadecimal string
    const encryptedMsg = cipher.toString('hex');
    log(`encryptRsa: Encrypted message (hex): ${encryptedMsg}`);

    return encryptedMsg;
  } catch (e) {
    err(`encryptRsa: Error encrypting message: ${e}`);
    return '';
  }
}
