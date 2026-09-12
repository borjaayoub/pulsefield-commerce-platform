import * as argon2 from 'argon2';
import type { PrismaClient } from '../src/generated/prisma/client';
import { RoleName, AccountStatus } from '../src/generated/prisma/enums';
import { validateAndNormalizePassword } from '../src/identity/password-policy';

export const DEMO_STAFF = {
  administrator: {
    id: '81000000-0000-4000-8000-000000000001',
    email: 'admin.phase3@pulsefield.local',
    role: RoleName.ADMINISTRATOR,
  },
  fulfiller: {
    id: '81000000-0000-4000-8000-000000000002',
    email: 'fulfiller.phase3@pulsefield.local',
    role: RoleName.FULFILLER,
  },
} as const;
const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  version: 0x13,
  memoryCost: 1 << 16,
  timeCost: 3,
  parallelism: 4,
} as const;

export async function seedDemoStaff(
  prisma: PrismaClient,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const administratorPassword = environment.PHASE3_DEMO_ADMIN_PASSWORD;
  const fulfillerPassword = environment.PHASE3_DEMO_FULFILLER_PASSWORD;
  if (!administratorPassword || !fulfillerPassword)
    throw new Error(
      'Phase 3 demo reset requires PHASE3_DEMO_ADMIN_PASSWORD and PHASE3_DEMO_FULFILLER_PASSWORD in the ignored environment.',
    );
  const passwords = [administratorPassword, fulfillerPassword].map((password) =>
    validateAndNormalizePassword(password),
  );
  for (const [index, identity] of Object.values(DEMO_STAFF).entries()) {
    const user = await prisma.user.upsert({
      where: { id: identity.id },
      create: {
        id: identity.id,
        emailNormalized: identity.email,
        passwordHash: await argon2.hash(passwords[index]!, ARGON2ID_OPTIONS),
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date('2026-09-10T00:00:00.000Z'),
      },
      update: {
        emailNormalized: identity.email,
        passwordHash: await argon2.hash(passwords[index]!, ARGON2ID_OPTIONS),
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date('2026-09-10T00:00:00.000Z'),
        totpSecretCiphertext: null,
        totpEnrolledAt: null,
        totpLastUsedStep: null,
      },
    });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({ data: { userId: user.id, role: identity.role } });
  }
}
