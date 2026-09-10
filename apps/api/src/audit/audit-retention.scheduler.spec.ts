import type { LocalProfile } from '@pulse-field/foundation';
import { AuditRetentionHeldError } from './audit.errors';
import {
  AuditRetentionScheduler,
  AUDIT_RETENTION_SCHEDULE_BATCH_SIZE,
} from './audit-retention.scheduler';

describe('AuditRetentionScheduler', () => {
  function profile(nodeEnv: LocalProfile['NODE_ENV']): LocalProfile {
    return { NODE_ENV: nodeEnv } as LocalProfile;
  }

  it('does not schedule retention while running tests', () => {
    const purgeExpired = jest.fn();
    const scheduler = new AuditRetentionScheduler({ purgeExpired } as never, profile('test'));

    scheduler.onApplicationBootstrap();

    expect(purgeExpired).not.toHaveBeenCalled();
  });

  it('invokes the internal retention service with only its system context', async () => {
    const purgeExpired = jest.fn().mockResolvedValue(undefined);
    const scheduler = new AuditRetentionScheduler(
      { purgeExpired } as never,
      profile('development'),
    );

    await scheduler.purgeOnce();

    expect(purgeExpired).toHaveBeenCalledWith(
      AUDIT_RETENTION_SCHEDULE_BATCH_SIZE,
      expect.objectContaining({
        actor: {
          type: 'system',
          id: 'audit-retention-scheduler',
          roles: ['AUDIT_RETENTION'],
        },
      }),
    );
  });

  it('treats an active investigation hold as an expected pause', async () => {
    const purgeExpired = jest.fn().mockRejectedValue(new AuditRetentionHeldError());
    const scheduler = new AuditRetentionScheduler(
      { purgeExpired } as never,
      profile('development'),
    );

    await expect(scheduler.purgeOnce()).resolves.toBeUndefined();
  });
});
