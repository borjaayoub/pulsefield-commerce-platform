import { validateLocalProfile } from '@pulse-field/foundation';
import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '../src/generated/prisma/client';
import { TotpSecretCipher } from '../src/identity/totp-secret-cipher';

loadEnvironment({ path: resolve(process.cwd(), '.env') });
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

async function main(): Promise<void> {
  const profile = validateLocalProfile(process.env);
  if (profile.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64 === undefined) {
    throw new Error('Start a message-key rotation before re-encrypting TOTP secrets.');
  }

  const cipher = new TotpSecretCipher({
    current: profile.MESSAGE_ENCRYPTION_KEY_BASE64,
    previous: profile.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64,
  });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: profile.DATABASE_URL }),
  });

  try {
    const rotated = await prisma.$transaction(async (transaction) => {
      const users = await transaction.user.findMany({
        where: { totpSecretCiphertext: { not: null } },
        select: { id: true, totpSecretCiphertext: true },
      });
      let count = 0;

      for (const user of users) {
        if (
          !user.totpSecretCiphertext ||
          cipher.isProtectedWithActiveKey(user.totpSecretCiphertext)
        ) {
          continue;
        }
        const secret = cipher.unprotect(user.totpSecretCiphertext, user.id);
        const updated = await transaction.user.updateMany({
          where: { id: user.id, totpSecretCiphertext: user.totpSecretCiphertext },
          data: { totpSecretCiphertext: cipher.protect(secret, user.id) },
        });
        if (updated.count !== 1) throw new Error('TOTP secret changed during rotation.');
        count += 1;
      }
      return count;
    });
    process.stdout.write(`Re-encrypted ${rotated} staff TOTP secrets using the active key.\n`);
  } catch {
    process.stderr.write(
      'TOTP secret re-encryption could not complete; the previous key remains required.\n',
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
