import type { CommandContext } from '@pulse-field/contracts';
import { PrismaService } from '../database/prisma.service';
import { AuditActorType, IdempotencyStatus } from '../generated/prisma/enums';
import { IdempotencyClaimLostError, IdempotencyConflictError } from './idempotency.errors';
import { IdempotencyService } from './idempotency.service';
import { fingerprintIdempotentRequest } from './request-fingerprint';

describe('IdempotencyService', () => {
  const context: CommandContext = {
    idempotencyKey: 'idempotency-checkout-123456',
    requestId: 'request-checkout-123456',
    correlationId: 'correlation-checkout-123456',
    actor: { type: 'customer', id: 'customer-123', roles: ['CUSTOMER'] },
  };
  const request = { cartId: 'cart-123', expectedVersion: 4 };

  function subject() {
    const create = jest.fn();
    const findUnique = jest.fn();
    const findUniqueOrThrow = jest.fn();
    const updateMany = jest.fn();
    const prisma = {
      idempotencyRecord: { create, findUnique, findUniqueOrThrow, updateMany },
    } as unknown as PrismaService;
    return {
      service: new IdempotencyService(prisma),
      create,
      findUnique,
      findUniqueOrThrow,
      updateMany,
    };
  }

  it('stores digests and returns the raw claim token only to the owner', async () => {
    const { service, create } = subject();
    create.mockImplementationOnce(({ data }) =>
      Promise.resolve({ ...data, id: 'record-123', attemptCount: 1 }),
    );

    const result = await service.begin({ operation: 'checkout.create', request }, context);

    expect(result).toMatchObject({
      kind: 'acquired',
      claim: { recordId: 'record-123' },
      attemptCount: 1,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: AuditActorType.CUSTOMER,
        actorId: 'customer-123',
        operation: 'checkout.create',
        keyDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        claimTokenDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain(context.idempotencyKey);
    expect(JSON.stringify(create.mock.calls)).not.toContain('cart-123');
  });

  it('returns in-progress for an identical live claim', async () => {
    const { service, create, findUnique, findUniqueOrThrow } = subject();
    create.mockRejectedValueOnce(new Error('unique'));
    findUnique.mockResolvedValueOnce({ id: 'record-123' });
    findUniqueOrThrow.mockResolvedValueOnce({
      id: 'record-123',
      requestFingerprint: fingerprintIdempotentRequest('checkout.create', request),
      status: IdempotencyStatus.IN_PROGRESS,
      lockedUntil: new Date(Date.now() + 10_000),
    });

    await expect(
      service.begin({ operation: 'checkout.create', request }, context),
    ).resolves.toMatchObject({
      kind: 'in-progress',
      retryAfterMs: expect.any(Number),
    });
  });

  it('rejects reuse of a key for different input', async () => {
    const { service, create, findUnique, findUniqueOrThrow } = subject();
    create.mockRejectedValueOnce(new Error('unique'));
    findUnique.mockResolvedValueOnce({ id: 'record-123' });
    findUniqueOrThrow.mockResolvedValueOnce({
      id: 'record-123',
      requestFingerprint: '0'.repeat(64),
      status: IdempotencyStatus.IN_PROGRESS,
    });

    await expect(service.begin({ operation: 'checkout.create', request }, context)).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  it('replays only the safe completed resource reference', async () => {
    const { service, create, findUnique, findUniqueOrThrow } = subject();
    create.mockRejectedValueOnce(new Error('unique'));
    findUnique.mockResolvedValueOnce({ id: 'record-123' });
    findUniqueOrThrow.mockResolvedValueOnce({
      id: 'record-123',
      requestFingerprint: fingerprintIdempotentRequest('checkout.create', request),
      status: IdempotencyStatus.COMPLETED,
      resultType: 'checkout',
      resultId: 'checkout-123',
      responseStatus: 201,
    });

    await expect(
      service.begin({ operation: 'checkout.create', request }, context),
    ).resolves.toEqual({
      kind: 'replay',
      result: { type: 'checkout', id: 'checkout-123', responseStatus: 201 },
    });
  });

  it('prevents a stale owner from completing after its token was replaced', async () => {
    const { service, updateMany } = subject();
    updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.complete(
        { idempotencyRecord: { updateMany } } as never,
        { recordId: 'record-123', token: 'obsolete-claim-token-123' },
        { type: 'checkout', id: 'checkout-123', responseStatus: 201 },
      ),
    ).rejects.toThrow(IdempotencyClaimLostError);
  });
});
