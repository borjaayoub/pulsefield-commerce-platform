import { createHash } from 'node:crypto';
import { seedPhase3Commerce } from '../../prisma/seed-commerce';
import { PrismaService } from '../database/prisma.service';
import { CartService } from './cart.service';
import { CartRevisionConflictError } from './cart.errors';
import { CartItemUnavailableError } from './cart.errors';
import { CatalogLifecycle } from '../generated/prisma/enums';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('persistent anonymous cart database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const carts = new CartService(prisma);
  const variantId = '30000000-0000-4000-8000-000000000001';

  beforeEach(async () => {
    await clearCommerceData(prisma);
    await seedPhase3Commerce(prisma);
  });

  afterAll(async () => {
    await clearCommerceData(prisma);
    await prisma.$disconnect();
  });

  it('persists a server-priced cart and digest-only identity', async () => {
    const empty = await carts.getCurrent(undefined);
    const updated = await carts.setItem(empty.token, variantId, 2, empty.cart.revision);

    expect(updated.cart).toMatchObject({
      revision: 2,
      currency: 'USD',
      subtotalMinor: 9600,
      items: [
        {
          variantId,
          quantity: 2,
          currentUnitPriceMinor: 4800,
          purchasable: true,
          media: {
            url: '/catalog/seed/aero-tempo-tee.svg',
            altText: expect.any(String),
            width: expect.any(Number),
            height: expect.any(Number),
          },
        },
      ],
    });
    const stored = await prisma.cart.findUniqueOrThrow({ where: { id: await findCartId(prisma) } });
    expect(stored.tokenDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.tokenDigest).not.toContain(empty.token);
  });

  it('omits active media whose storage key is outside the public catalog allowlist', async () => {
    await prisma.productMedia.updateMany({
      where: { productId: '20000000-0000-4000-8000-000000000001' },
      data: { storageKey: 'private/aero-tempo-tee.png' },
    });
    const empty = await carts.getCurrent(undefined);
    const updated = await carts.setItem(empty.token, variantId, 1, empty.cart.revision);

    expect(updated.cart.items[0]?.media).toBeNull();
  });

  it('allows only one writer for the same cart revision', async () => {
    const empty = await carts.getCurrent(undefined);
    const attempts = await Promise.allSettled([
      carts.setItem(empty.token, variantId, 1, empty.cart.revision),
      carts.setItem(empty.token, variantId, 2, empty.cart.revision),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(
      attempts.some(
        (attempt) =>
          attempt.status === 'rejected' && attempt.reason instanceof CartRevisionConflictError,
      ),
    ).toBe(true);
    await expect(prisma.cartItem.count()).resolves.toBe(1);
    await expect(prisma.cart.count()).resolves.toBe(1);
  });

  it('does not persist an orphan when a first mutation is unavailable', async () => {
    await expect(
      carts.setItem(undefined, '30000000-0000-4000-8000-000000000099', 1),
    ).rejects.toBeInstanceOf(CartItemUnavailableError);
    await expect(prisma.cart.count()).resolves.toBe(0);
  });

  it('replaces an expired cookie cart atomically and ignores its old revision', async () => {
    const original = await carts.getCurrent(undefined);
    await prisma.cart.update({
      where: { tokenDigest: requireDigest(original.token) },
      data: {
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        expiresAt: new Date('2020-01-02T00:00:00.000Z'),
        absoluteExpiresAt: new Date('2020-01-03T00:00:00.000Z'),
      },
    });
    const replacement = await carts.setItem(original.token, variantId, 1, 999);
    expect(replacement.createdCookie).toBe(true);
    expect(replacement.token).not.toBe(original.token);
    await expect(prisma.cartItem.count()).resolves.toBe(1);
    await expect(prisma.cart.count()).resolves.toBe(2);
  });

  it('retains an archived line with nullable current price and product identity', async () => {
    const original = await carts.getCurrent(undefined);
    await carts.setItem(original.token, variantId, 1, original.cart.revision);
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { status: CatalogLifecycle.ARCHIVED, archivedAt: new Date() },
    });
    const current = await carts.getCurrent(original.token);
    expect(current.cart.items[0]).toMatchObject({
      productId: '20000000-0000-4000-8000-000000000001',
      productName: 'Aero Tempo Tee',
      currentUnitPriceMinor: null,
      currentLinePriceMinor: null,
      purchasable: false,
    });
    expect(current.cart.hasUnavailableItems).toBe(true);
  });

  it('keeps same-quantity and absent-line deletes at the same revision', async () => {
    const original = await carts.getCurrent(undefined);
    const added = await carts.setItem(original.token, variantId, 1, original.cart.revision);
    const same = await carts.setItem(added.token, variantId, 1, added.revision);
    const removed = await carts.removeItem(
      same.token,
      '30000000-0000-4000-8000-000000000002',
      same.revision,
    );
    expect(same.revision).toBe(added.revision);
    expect(same.changed).toBe(false);
    expect(removed.revision).toBe(same.revision);
    expect(removed.changed).toBe(false);
  });

  it('rejects invalid persisted cart quantities and revisions', async () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const absoluteExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const cart = await prisma.cart.create({
      data: {
        tokenDigest: requireDigest('a'.repeat(43)),
        expiresAt,
        absoluteExpiresAt,
      },
    });
    await expect(
      prisma.cartItem.create({ data: { cartId: cart.id, variantId, quantity: 0 } }),
    ).rejects.toThrow();
    await expect(
      prisma.cart.update({ where: { id: cart.id }, data: { revision: 0 } }),
    ).rejects.toThrow();
  });

  it('allows one concurrent writer against an existing line', async () => {
    const original = await carts.getCurrent(undefined);
    const added = await carts.setItem(original.token, variantId, 1, original.cart.revision);
    const attempts = await Promise.allSettled([
      carts.setItem(added.token, variantId, 2, added.revision),
      carts.setItem(added.token, variantId, 3, added.revision),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await expect(prisma.cartItem.findFirstOrThrow()).resolves.toMatchObject({
      quantity: expect.any(Number),
    });
  });

  it('sweeps expired carts in a bounded batch', async () => {
    const expired = await prisma.cart.create({
      data: {
        tokenDigest: requireDigest('e'.repeat(43)),
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        expiresAt: new Date('2020-01-02T00:00:00.000Z'),
        absoluteExpiresAt: new Date('2020-01-03T00:00:00.000Z'),
      },
    });
    const active = await carts.getCurrent(undefined);

    await expect(carts.sweepExpired(1)).resolves.toBe(1);
    await expect(prisma.cart.findUnique({ where: { id: expired.id } })).resolves.toBeNull();
    await expect(
      prisma.cart.findUnique({ where: { tokenDigest: requireDigest(active.token) } }),
    ).resolves.toBeTruthy();
  });
});

async function clearCommerceData(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Cart", "InventoryMovement", "InventoryBalance", "InventoryAllocationPolicyWarehouse", "InventoryAllocationPolicyVersion", "InventoryAllocationPolicy", "VariantPrice", "PriceBookVersion", "PriceBook", "ProductVariant", "Product", "Warehouse" CASCADE',
  );
}

function requireDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function findCartId(prisma: PrismaService): Promise<string> {
  const cart = await prisma.cart.findFirstOrThrow();
  return cart.id;
}
