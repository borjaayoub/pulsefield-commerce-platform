import type { LocalProfile } from '@pulse-field/foundation';
import { IdempotencyRetentionScheduler } from './idempotency-retention.scheduler';
import { IDEMPOTENCY_RETENTION_BATCH_SIZE } from './idempotency-retention.service';

describe('IdempotencyRetentionScheduler', () => {
  function profile(nodeEnv: LocalProfile['NODE_ENV']): LocalProfile {
    return { NODE_ENV: nodeEnv } as LocalProfile;
  }

  it('does not schedule retention while running tests', () => {
    const purgeExpired = jest.fn();
    const scheduler = new IdempotencyRetentionScheduler({ purgeExpired } as never, profile('test'));

    scheduler.onApplicationBootstrap();
    expect(purgeExpired).not.toHaveBeenCalled();
  });

  it('invokes the internal retention service with only its system context', async () => {
    const purgeExpired = jest.fn().mockResolvedValue(undefined);
    const scheduler = new IdempotencyRetentionScheduler(
      { purgeExpired } as never,
      profile('development'),
    );

    await scheduler.purgeOnce();

    expect(purgeExpired).toHaveBeenCalledWith(
      IDEMPOTENCY_RETENTION_BATCH_SIZE,
      expect.objectContaining({
        actor: {
          type: 'system',
          id: 'idempotency-retention-scheduler',
          roles: ['IDEMPOTENCY_RETENTION'],
        },
      }),
    );
  });
});
