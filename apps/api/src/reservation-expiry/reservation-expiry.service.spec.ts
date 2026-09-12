import { ReservationExpiryService } from './reservation-expiry.service';
import { ReservationExpirySweepError } from './reservation-expiry.errors';

describe('ReservationExpiryService', () => {
  it('continues after one candidate fails and reports the partial failure', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { id: '90000000-0000-4000-8000-000000000001' },
          { id: '90000000-0000-4000-8000-000000000002' },
        ]),
    };
    const service = new ReservationExpiryService(prisma as never, {} as never);
    const expireOne = jest
      .spyOn(
        service as unknown as {
          expireOne: (reservationId: string) => Promise<boolean>;
        },
        'expireOne',
      )
      .mockRejectedValueOnce(new Error('database details must stay private'))
      .mockResolvedValueOnce(true);

    await expect(service.sweepExpired()).rejects.toEqual(new ReservationExpirySweepError(1, 1));
    expect(expireOne).toHaveBeenNthCalledWith(1, '90000000-0000-4000-8000-000000000001');
    expect(expireOne).toHaveBeenNthCalledWith(2, '90000000-0000-4000-8000-000000000002');
  });
});
