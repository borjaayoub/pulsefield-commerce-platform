import type { LocalProfile } from '@pulse-field/foundation';
import {
  RESERVATION_EXPIRY_INTERVAL_MS,
  ReservationExpiryScheduler,
} from './reservation-expiry.scheduler';
import { ReservationExpirySweepError } from './reservation-expiry.errors';
import { RESERVATION_EXPIRY_BATCH_SIZE } from './reservation-expiry.service';

function profile(nodeEnv: LocalProfile['NODE_ENV']): LocalProfile {
  return { NODE_ENV: nodeEnv } as LocalProfile;
}

describe('ReservationExpiryScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not schedule database work in the test profile', () => {
    const expiry = { sweepExpired: jest.fn().mockResolvedValue(0) };
    const scheduler = new ReservationExpiryScheduler(expiry as never, profile('test'));

    scheduler.onApplicationBootstrap();

    expect(expiry.sweepExpired).not.toHaveBeenCalled();
  });

  it('runs one bounded sweep at startup and then every sixty seconds', async () => {
    jest.useFakeTimers();
    const expiry = { sweepExpired: jest.fn().mockResolvedValue(0) };
    const scheduler = new ReservationExpiryScheduler(expiry as never, profile('development'));

    scheduler.onApplicationBootstrap();
    await Promise.resolve();
    expect(expiry.sweepExpired).toHaveBeenCalledWith(RESERVATION_EXPIRY_BATCH_SIZE);

    jest.advanceTimersByTime(RESERVATION_EXPIRY_INTERVAL_MS);
    await Promise.resolve();
    expect(expiry.sweepExpired).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
  });

  it('does not overlap a slow sweep', async () => {
    let resolve: (() => void) | undefined;
    const pending = new Promise<number>((done) => {
      resolve = () => done(0);
    });
    const expiry = { sweepExpired: jest.fn().mockReturnValue(pending) };
    const scheduler = new ReservationExpiryScheduler(expiry as never, profile('test'));

    const first = scheduler.runOnce();
    const second = scheduler.runOnce();
    expect(expiry.sweepExpired).toHaveBeenCalledTimes(1);
    resolve!();
    await Promise.all([first, second]);
  });

  it('logs only aggregate details when a bounded sweep has candidate failures', async () => {
    const expiry = {
      sweepExpired: jest.fn().mockRejectedValue(new ReservationExpirySweepError(2, 1)),
    };
    const scheduler = new ReservationExpiryScheduler(expiry as never, profile('test'));
    const logger = (scheduler as unknown as { logger: { warn: jest.Mock } }).logger;
    const warn = jest.spyOn(logger, 'warn');

    await scheduler.runOnce();

    expect(warn).toHaveBeenCalledWith(
      'Reservation expiry sweep had 1 failed candidate(s) after 2 success(es).',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('database');
  });
});
