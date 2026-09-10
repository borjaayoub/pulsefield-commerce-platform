import { parseMessageEncryptionKey } from '@pulse-field/foundation';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

interface LegacyEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface CurrentEnvelope {
  version: 2;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

type Envelope = LegacyEnvelope | CurrentEnvelope;

interface KeyMaterial {
  encoded: string;
  key: Buffer;
  keyId: string;
}

export interface TotpSecretProtectionKeys {
  current: string;
  previous?: string;
}

function keyMaterial(encoded: string): KeyMaterial {
  const key = parseMessageEncryptionKey(encoded);
  return {
    encoded,
    key,
    keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
  };
}

function parseCanonicalBase64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Invalid protected TOTP secret.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (length !== undefined && decoded.length !== length)) {
    throw new Error('Invalid protected TOTP secret.');
  }
  return decoded;
}

function parseEnvelope(encoded: string): Envelope {
  const value: unknown = JSON.parse(encoded);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid protected TOTP secret.');
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== 1 && envelope.version !== 2) {
    throw new Error('Unsupported protected TOTP secret.');
  }
  if (
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    typeof envelope.ciphertext !== 'string' ||
    (envelope.version === 2 &&
      (typeof envelope.keyId !== 'string' || !/^[a-f0-9]{16}$/.test(envelope.keyId)))
  ) {
    throw new Error('Invalid protected TOTP secret.');
  }
  return envelope as unknown as Envelope;
}

export class TotpSecretCipher {
  private readonly current: KeyMaterial;
  private readonly previous?: KeyMaterial;

  constructor(keys: TotpSecretProtectionKeys) {
    this.current = keyMaterial(keys.current);
    this.previous = keys.previous === undefined ? undefined : keyMaterial(keys.previous);
    if (this.previous?.encoded === this.current.encoded) {
      throw new Error('Previous TOTP protection key must differ from the active key.');
    }
  }

  get activeKeyId(): string {
    return this.current.keyId;
  }

  protect(secret: string, userId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv);
    cipher.setAAD(Buffer.from(`pulse-field:totp-secret:v1:${userId}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return JSON.stringify({
      version: 2,
      keyId: this.current.keyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    } satisfies CurrentEnvelope);
  }

  unprotect(encoded: string, userId: string): string {
    try {
      const envelope = parseEnvelope(encoded);
      const candidates =
        envelope.version === 2
          ? [this.current, this.previous].filter(
              (candidate): candidate is KeyMaterial => candidate?.keyId === envelope.keyId,
            )
          : [this.current, this.previous].filter(
              (candidate): candidate is KeyMaterial => candidate !== undefined,
            );

      for (const candidate of candidates) {
        try {
          const decipher = createDecipheriv(
            'aes-256-gcm',
            candidate.key,
            parseCanonicalBase64(envelope.iv, 12),
          );
          decipher.setAAD(Buffer.from(`pulse-field:totp-secret:v1:${userId}`, 'utf8'));
          decipher.setAuthTag(parseCanonicalBase64(envelope.tag, 16));
          return Buffer.concat([
            decipher.update(parseCanonicalBase64(envelope.ciphertext)),
            decipher.final(),
          ]).toString('utf8');
        } catch {
          // A matching key can still fail when the ciphertext or bound user ID is altered.
        }
      }

      throw new Error('Protected TOTP secret could not be decrypted.');
    } catch {
      throw new MfaSecretProtectionError();
    }
  }

  isProtectedWithActiveKey(encoded: string): boolean {
    try {
      const envelope = parseEnvelope(encoded);
      return envelope.version === 2 && envelope.keyId === this.current.keyId;
    } catch {
      return false;
    }
  }
}

export class MfaSecretProtectionError extends Error {
  readonly name = 'MfaSecretProtectionError';
}
