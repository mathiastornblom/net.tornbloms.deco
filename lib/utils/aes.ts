import crypto from 'crypto';
import { debug } from 'debug';
const err = debug('app:error');
const log = debug('app:log');

// Interface to define the structure of an AES key and IV
export interface AESKey {
  key: Buffer;
  iv: Buffer;
}

// Custom error messages for PKCS7 padding errors
const ErrInvalidBlockSize = new Error('invalid blocksize');
const ErrInvalidPKCS7Data = new Error(
  'invalid PKCS7 data (empty or not padded)',
);

// Function to generate a random AES-128 key and initialization vector (IV)
export function generateAESKey(): AESKey {
  const key = Buffer.from(
    Math.floor(Math.random() * 1e16)
      .toString()
      .padStart(16, '0'),
  );
  const iv = Buffer.from(
    Math.floor(Math.random() * 1e16)
      .toString()
      .padStart(16, '0'),
  );

  log(`GenerateAESKey: Generated AES Key: ${key.toString('hex')}`);
  log(`GenerateAESKey: Generated AES IV: ${iv.toString('hex')}`);

  return { key, iv };
}

// Function to encrypt plaintext using AES-128-CBC mode
export function AES128Encrypt(plaintext: string, key: AESKey): string {
  try {
    log('AES128Encrypt: Starting AES128 encryption.');
    log(`AES128Encrypt: Plaintext to encrypt: ${plaintext}`);
    log(`AES128Encrypt: Using AES Key: ${key.key.toString('hex')}`);
    log(`AES128Encrypt: Using AES IV: ${key.iv.toString('hex')}`);

    // Apply PKCS7 padding to the plaintext
    const bPlaintext = pkcs7Padding(Buffer.from(plaintext), 16);
    const cipher = crypto.createCipheriv('aes-128-cbc', key.key, key.iv);
    const encrypted = Buffer.concat([
      cipher.update(bPlaintext),
      cipher.final(),
    ]);

    const encryptedText = encrypted.toString('base64');
    log(`AES128Encrypt: Encrypted text (base64): ${encryptedText}`);

    return encryptedText;
  } catch (e) {
    err(`AES128Encrypt: Error during encryption: ${e}`);
    return '';
  }
}

// Function to decrypt ciphertext using AES-128-CBC mode
export function AES128Decrypt(encrypted: string, key: AESKey): string {
  try {
    log('AES128Decrypt: Starting AES128 decryption.');
    log(`AES128Decrypt: Encrypted text to decrypt: ${encrypted}`);
    log(`AES128Decrypt: Using AES Key: ${key.key.toString('hex')}`);
    log(`AES128Decrypt: Using AES IV: ${key.iv.toString('hex')}`);

    const cipherText = Buffer.from(encrypted, 'base64');
    log(`AES128Decrypt: Ciphertext length: ${cipherText.length}`);

    const decipher = crypto.createDecipheriv('aes-128-cbc', key.key, key.iv);
    const decrypted = Buffer.concat([
      decipher.update(cipherText),
      decipher.final(),
    ]);

    log(`AES128Decrypt: Decrypted buffer length: ${decrypted.length}`);

    const decryptedText = decrypted.toString();
    log(`AES128Decrypt: Decrypted text: ${decryptedText}`);

    return decryptedText;
  } catch (e) {
    err(`AES128Decrypt: Error during decryption: ${e}`);
    return '';
  }
}

// Function to apply PKCS7 padding to a buffer
function pkcs7Padding(buffer: Buffer, blockSize: number): Buffer {
  if (blockSize <= 0) throw ErrInvalidBlockSize;
  if (buffer.length === 0) throw ErrInvalidPKCS7Data;

  const paddingSize = blockSize - (buffer.length % blockSize);
  const padding = Buffer.alloc(paddingSize, paddingSize);
  return Buffer.concat([buffer, padding]);
}
