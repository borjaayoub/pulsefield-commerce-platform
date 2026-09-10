import {
  decryptQueueMessage,
  encryptQueueMessage,
  parseMessageEncryptionKey,
} from './message-encryption';

const key = Buffer.alloc(32, 7).toString('base64');

describe('queue message encryption', () => {
  it('round-trips a JSON value through authenticated encryption', () => {
    const value = { recipient: 'customer@example.test', token: 'secret-token' };
    const envelope = encryptQueueMessage(value, key);

    expect(decryptQueueMessage(envelope, key)).toEqual(value);
  });

  it('uses a fresh initialization vector for the same value', () => {
    const first = encryptQueueMessage({ token: 'same-secret' }, key);
    const second = encryptQueueMessage({ token: 'same-secret' }, key);

    expect(first.initializationVector).not.toBe(second.initializationVector);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('does not serialize plaintext secrets into the envelope', () => {
    const envelope = encryptQueueMessage(
      { recipient: 'customer@example.test', token: 'secret-token' },
      key,
    );
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain('customer@example.test');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain(key);
  });

  it('rejects tampered ciphertext', () => {
    const envelope = encryptQueueMessage({ token: 'secret-token' }, key);
    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA`,
    };

    expect(() => decryptQueueMessage(tampered, key)).toThrow(
      'Encrypted queue message could not be decrypted.',
    );
  });

  it('rejects malformed base64 envelope fields', () => {
    const envelope = encryptQueueMessage({ token: 'secret-token' }, key);

    expect(() =>
      decryptQueueMessage({ ...envelope, initializationVector: 'not-base64' }, key),
    ).toThrow('Encrypted queue message could not be decrypted.');
  });

  it('rejects keys that are not canonical base64-encoded 32-byte values', () => {
    expect(() => parseMessageEncryptionKey('not-a-key')).toThrow('MESSAGE_ENCRYPTION_KEY_BASE64');
  });

  it('uses a configured previous key only when the active key cannot authenticate an old message', () => {
    const previousKey = Buffer.alloc(32, 8).toString('base64');
    const activeKey = Buffer.alloc(32, 9).toString('base64');
    const envelope = encryptQueueMessage({ token: 'old-secret' }, previousKey);

    expect(decryptQueueMessage(envelope, activeKey, previousKey)).toEqual({ token: 'old-secret' });
    expect(() => decryptQueueMessage(envelope, activeKey)).toThrow(
      'Encrypted queue message could not be decrypted.',
    );
  });
});
