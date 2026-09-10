import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface QueueMessageEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  initializationVector: string;
  authenticationTag: string;
  ciphertext: string;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const INITIALIZATION_VECTOR_BYTES = 12;
const AUTHENTICATED_CONTEXT = Buffer.from('pulse-field:queue-message:v1', 'utf8');
const canonicalBase64Pattern = /^[A-Za-z0-9+/]{43}=$/;

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Encrypted message field is not canonical base64.');
  }
  return decoded;
}

export function parseMessageEncryptionKey(encodedKey: string): Buffer {
  if (!canonicalBase64Pattern.test(encodedKey)) {
    throw new Error(
      'MESSAGE_ENCRYPTION_KEY_BASE64 must be one canonical base64-encoded 32-byte key.',
    );
  }

  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== encodedKey) {
    throw new Error(
      'MESSAGE_ENCRYPTION_KEY_BASE64 must be one canonical base64-encoded 32-byte key.',
    );
  }

  return key;
}

export function encryptQueueMessage(value: unknown, encodedKey: string): QueueMessageEnvelope {
  const key = parseMessageEncryptionKey(encodedKey);
  const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, initializationVector);
  cipher.setAAD(AUTHENTICATED_CONTEXT);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);

  return {
    version: 1,
    algorithm: ALGORITHM,
    initializationVector: initializationVector.toString('base64'),
    authenticationTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptWithKey(envelope: QueueMessageEnvelope, encodedKey: string): unknown {
  const key = parseMessageEncryptionKey(encodedKey);
  const initializationVector = decodeCanonicalBase64(envelope.initializationVector);
  const authenticationTag = decodeCanonicalBase64(envelope.authenticationTag);
  const ciphertext = decodeCanonicalBase64(envelope.ciphertext);

  if (
    initializationVector.length !== INITIALIZATION_VECTOR_BYTES ||
    authenticationTag.length !== 16
  ) {
    throw new Error('Invalid encrypted message envelope.');
  }

  const decipher = createDecipheriv(ALGORITHM, key, initializationVector);
  decipher.setAAD(AUTHENTICATED_CONTEXT);
  decipher.setAuthTag(authenticationTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as unknown;
}

export function decryptQueueMessage(
  envelope: QueueMessageEnvelope,
  encodedKey: string,
  previousEncodedKey?: string,
): unknown {
  try {
    if (envelope.version !== 1 || envelope.algorithm !== ALGORITHM) {
      throw new Error('Unsupported encrypted message envelope.');
    }

    try {
      return decryptWithKey(envelope, encodedKey);
    } catch {
      if (previousEncodedKey === undefined) throw new Error('Active key did not decrypt message.');
      return decryptWithKey(envelope, previousEncodedKey);
    }
  } catch {
    throw new Error('Encrypted queue message could not be decrypted.');
  }
}
