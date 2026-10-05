import { config as loadEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { seedPhase3Commerce } from './seed-commerce';
import { seedDemoStaff } from './seed-demo-staff';
import { seedInternationalCommerce } from './seed-international-commerce';

loadEnvironment({ path: resolve(process.cwd(), '.env') });
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for the deterministic seed.');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const COMMERCE_POLICY_ID = '62000000-0000-4000-8000-000000000001';

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

  await seedPhase3Commerce(prisma);
  const activePriceBookVersion = await prisma.priceBookVersion.findFirstOrThrow({
    where: {
      lifecycle: 'ACTIVE',
      priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
    },
    orderBy: { version: 'desc' },
  });
  await prisma.commercePolicyVersion.upsert({
    where: { version: 1 },
    create: {
      id: COMMERCE_POLICY_ID,
      version: 1,
      lifecycle: 'ACTIVE',
      effectiveFrom: new Date('2026-09-10T00:00:00.000Z'),
      countryCode: 'US',
      currencyCode: 'USD',
      priceBookVersionId: activePriceBookVersion.id,
      shippingBaseMinor: 800,
      freeShippingThresholdMinor: 12000,
      heavySurchargeMinor: 400,
      heavyThresholdGrams: 2000,
      taxRateBasisPoints: 825,
      reservationDurationSeconds: 600,
      calculationVersion: 'us-usd-2026-09-10',
    },
    update: {},
  });
  const activePolicies = await prisma.commercePolicyVersion.findMany({
    where: { lifecycle: 'ACTIVE', countryCode: 'US', currencyCode: 'USD' },
  });
  if (
    activePolicies.length !== 1 ||
    activePolicies[0]?.version !== 1 ||
    activePolicies[0]?.id !== COMMERCE_POLICY_ID
  ) {
    throw new Error('The deterministic seed requires exactly one active US/USD commerce policy.');
  }
  if (process.env.PHASE3_DEMO_MODE === 'true') await seedDemoStaff(prisma);
  await seedInternationalCommerce(prisma);
}

void main()
  .then(() =>
    process.stdout.write('Seeded foundation, US commerce and international demo configuration.\n'),
  )
  .finally(async () => prisma.$disconnect());
