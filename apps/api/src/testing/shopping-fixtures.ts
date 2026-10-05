import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client';

/** Explicit fixture transition for legacy expiry tests; no production caller. */
export async function setUsShoppingReservationDuration(
  prisma: PrismaClient,
  seconds: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.commerceMarketVersion.findFirstOrThrow({
      where: { lifecycle: 'ACTIVE', market: { code: 'US' } },
    });
    await tx.commerceMarketVersion.update({
      where: { id: current.id },
      data: { lifecycle: 'RETIRED' },
    });
    const next = await tx.commerceMarketVersion.create({
      data: {
        ...current,
        id: randomUUID(),
        version: current.version + 1,
        lifecycle: 'DRAFT',
        activatedAt: null,
        retiredAt: null,
        reservationDurationSeconds: seconds,
      },
    });
    await tx.commerceMarketVersion.update({
      where: { id: next.id },
      data: { lifecycle: 'ACTIVE' },
    });
  });
}
