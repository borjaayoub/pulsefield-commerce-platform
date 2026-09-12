import { FulfillmentGroupStatus, RoleName } from '../generated/prisma/enums';
import { ForbiddenError } from '../identity/authentication.errors';
import { FulfillmentConflictError } from './fulfillment.errors';
import { FulfillmentService } from './fulfillment.service';

const context = {
  requestId: 'fulfillment-service-test-001',
  correlationId: 'fulfillment-service-test-001',
  idempotencyKey: 'fulfillment-service-test-key-001',
  actor: {
    type: 'staff' as const,
    id: '90000000-0000-4000-8000-000000000001',
    roles: [RoleName.FULFILLER],
  },
  reason: 'Test a fulfillment transition.',
};

function service(): FulfillmentService {
  return new FulfillmentService({} as never, {} as never, {} as never);
}

describe('FulfillmentService command validation', () => {
  it('requires a current fulfillment revision and idempotency key', async () => {
    const fulfillment = service();
    await expect(
      fulfillment.transition(
        {
          fulfillmentGroupId: '90000000-0000-4000-8000-000000000002',
          expectedVersion: undefined,
          idempotencyKey: context.idempotencyKey,
          targetStatus: FulfillmentGroupStatus.PICKING,
          reason: context.reason,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'FULFILLMENT_REVISION_REQUIRED' });

    await expect(
      fulfillment.transition(
        {
          fulfillmentGroupId: '90000000-0000-4000-8000-000000000002',
          expectedVersion: 1,
          idempotencyKey: undefined,
          targetStatus: FulfillmentGroupStatus.PICKING,
          reason: context.reason,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('requires the fulfiller role before opening an idempotency claim', async () => {
    const fulfillment = service();
    await expect(
      fulfillment.transition(
        {
          fulfillmentGroupId: '90000000-0000-4000-8000-000000000002',
          expectedVersion: 1,
          idempotencyKey: context.idempotencyKey,
          targetStatus: FulfillmentGroupStatus.PICKING,
          reason: context.reason,
        },
        { ...context, actor: { ...context.actor, roles: [RoleName.ADMINISTRATOR] } },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each([
    [FulfillmentGroupStatus.ALLOCATED, undefined, undefined],
    [FulfillmentGroupStatus.SHIPPED, undefined, 'TRACKING1'],
    [FulfillmentGroupStatus.SHIPPED, 'UPS', undefined],
    [FulfillmentGroupStatus.PICKING, 'UPS', undefined],
  ])(
    'rejects invalid target-specific carrier data (%s)',
    async (targetStatus, carrierCode, trackingReference) => {
      const fulfillment = service();
      await expect(
        fulfillment.transition(
          {
            fulfillmentGroupId: '90000000-0000-4000-8000-000000000002',
            expectedVersion: 1,
            idempotencyKey: context.idempotencyKey,
            targetStatus: targetStatus as never,
            reason: context.reason,
            carrierCode,
            trackingReference,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' });
    },
  );

  it('rejects unsafe free-form reasons before they can reach audit storage', async () => {
    const fulfillment = service();
    await expect(
      fulfillment.transition(
        {
          fulfillmentGroupId: '90000000-0000-4000-8000-000000000002',
          expectedVersion: 1,
          idempotencyKey: context.idempotencyKey,
          targetStatus: FulfillmentGroupStatus.PICKING,
          reason: 'Call customer@example.test before picking.',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' });
  });

  it('normalizes a valid shipping command before persistence is attempted', async () => {
    const idempotency = {
      begin: jest.fn().mockResolvedValue({ kind: 'in-progress', retryAfterMs: 10 }),
    };
    const fulfillment = new FulfillmentService({} as never, idempotency as never, {} as never);
    await expect(
      fulfillment.transition(
        {
          fulfillmentGroupId: '90000000-0000-4000-8000-000000000002',
          expectedVersion: 3,
          idempotencyKey: context.idempotencyKey,
          targetStatus: FulfillmentGroupStatus.SHIPPED,
          reason: ' Ship the order. ',
          carrierCode: ' ups ',
          trackingReference: ' trk_123456 ',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'FULFILLMENT_UNAVAILABLE' });
    expect(idempotency.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'fulfillment.transition',
        request: expect.objectContaining({
          targetStatus: FulfillmentGroupStatus.SHIPPED,
          reason: 'Ship the order.',
          carrierCode: 'UPS',
          trackingReference: 'TRK_123456',
        }),
      }),
      context,
    );
  });

  it('exposes typed revision conflicts for callers', () => {
    const conflict = new FulfillmentConflictError(
      'FULFILLMENT_REVISION_CONFLICT',
      'Refresh the fulfillment group.',
      9,
    );
    expect(conflict.code).toBe('FULFILLMENT_REVISION_CONFLICT');
    expect(conflict.currentVersion).toBe(9);
  });
});
