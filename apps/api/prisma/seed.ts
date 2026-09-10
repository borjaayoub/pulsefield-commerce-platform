import { config as loadEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

loadEnvironment({ path: resolve(process.cwd(), '.env') });
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for the deterministic seed.');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main(): Promise<void> {
  await prisma.foundationSetting.upsert({
    where: { key: 'foundation.profile' },
    create: {
      key: 'foundation.profile',
      version: 1,
      latestRevision: 1,
      value: {
        profile: 'zero-cost-local',
        status: 'phase-1-ready',
        paymentProvider: 'stub',
        smtpProvider: 'mailpit',
      },
      revisions: {
        create: {
          version: 1,
          value: {
            profile: 'zero-cost-local',
            status: 'phase-1-ready',
            paymentProvider: 'stub',
            smtpProvider: 'mailpit',
          },
          lifecycle: 'ACTIVE',
          validationResult: { valid: true, issues: [] },
          authoredBy: 'system:phase-1-seed',
          approvedBy: 'system:phase-1-seed',
          activatedBy: 'system:phase-1-seed',
          effectiveFrom: new Date(),
        },
      },
    },
    update: {},
  });
}

void main()
  .then(() => process.stdout.write('Seeded Phase 1 foundation settings.\n'))
  .finally(async () => prisma.$disconnect());
