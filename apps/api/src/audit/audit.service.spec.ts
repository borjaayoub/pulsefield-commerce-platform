import type { AuditedCommandContext } from './command-context';
import { UnsafeAuditMetadataError } from './audit.errors';
import { AuditService, type AuditRecordWriter } from './audit.service';

describe('AuditService', () => {
  const service = new AuditService();

  function context(): AuditedCommandContext {
    return {
      requestId: 'request-12345678',
      correlationId: 'correlation-12345678',
      causationId: 'causation-12345678',
      idempotencyKey: 'idempotency-12345678',
      reason: 'Activate a reviewed configuration revision.',
      actor: {
        type: 'staff',
        id: 'administrator-1',
        roles: ['FULFILLER', 'ADMINISTRATOR'],
      },
    };
  }

  function writer() {
    return {
      auditRecord: { create: jest.fn().mockImplementation(({ data }) => data) },
    } as unknown as AuditRecordWriter;
  }

  it('appends bounded actor, correlation, target, and safe state metadata', async () => {
    const target = writer();

    await service.append(
      target,
      {
        action: 'configuration.foundation.activated',
        targetType: 'foundation-setting',
        targetId: 'foundation.profile',
        beforeMetadata: { activeVersion: 1, lifecycle: 'ACTIVE' },
        afterMetadata: { activeVersion: 3, sourceRevisionVersion: 2 },
      },
      context(),
    );

    expect(target.auditRecord.create).toHaveBeenCalledWith({
      data: {
        schemaVersion: 1,
        actorType: 'STAFF',
        actorId: 'administrator-1',
        actorRoles: ['ADMINISTRATOR', 'FULFILLER'],
        action: 'configuration.foundation.activated',
        targetType: 'foundation-setting',
        targetId: 'foundation.profile',
        requestId: 'request-12345678',
        correlationId: 'correlation-12345678',
        causationId: 'causation-12345678',
        idempotencyKey: 'idempotency-12345678',
        reason: 'Activate a reviewed configuration revision.',
        beforeMetadata: { activeVersion: 1, lifecycle: 'ACTIVE' },
        afterMetadata: { activeVersion: 3, sourceRevisionVersion: 2 },
      },
    });
  });

  it.each([
    { password: 'do-not-store' },
    { customerEmail: 'person@example.test' },
    { recoveryToken: 'do-not-store' },
    { nested: { totpSecret: 'do-not-store' } },
  ])('rejects sensitive metadata keys', async (afterMetadata) => {
    await expect(
      service.append(
        writer(),
        {
          action: 'configuration.foundation.activated',
          targetType: 'foundation-setting',
          targetId: 'foundation.profile',
          afterMetadata,
        },
        context(),
      ),
    ).rejects.toBeInstanceOf(UnsafeAuditMetadataError);
  });

  it('rejects non-plain, excessively deep, and oversized metadata', async () => {
    const nested = { level1: { level2: { level3: { level4: { level5: true } } } } };
    const oversized = { note: 'x'.repeat(4_097) };

    for (const afterMetadata of [new Date(), nested, oversized]) {
      await expect(
        service.append(
          writer(),
          {
            action: 'configuration.foundation.activated',
            targetType: 'foundation-setting',
            targetId: 'foundation.profile',
            afterMetadata,
          },
          context(),
        ),
      ).rejects.toBeInstanceOf(UnsafeAuditMetadataError);
    }
  });

  it('rejects a personal email address used as the audit target identifier', async () => {
    await expect(
      service.append(
        writer(),
        {
          action: 'configuration.foundation.activated',
          targetType: 'foundation-setting',
          targetId: 'person@example.test',
        },
        context(),
      ),
    ).rejects.toBeInstanceOf(UnsafeAuditMetadataError);
  });
});
