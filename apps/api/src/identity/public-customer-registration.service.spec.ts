import { Prisma } from '../generated/prisma/client';
import { CustomerRegistrationService } from './customer-registration.service';
import {
  isNormalizedEmailConflict,
  PublicCustomerRegistrationService,
} from './public-customer-registration.service';

function knownRequestError(
  code: string,
  meta: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Database request failed.', {
    code,
    clientVersion: '7.10.0',
    meta,
  });
}

describe('PublicCustomerRegistrationService', () => {
  function createSubject() {
    const register = jest.fn<Promise<unknown>, [unknown, unknown]>();
    const internal = { register } as unknown as CustomerRegistrationService;

    return {
      service: new PublicCustomerRegistrationService(internal),
      register,
    };
  }

  it('delegates new registration without changing the application input or context', async () => {
    const { service, register } = createSubject();
    register.mockResolvedValue({ id: 'internal-result-is-not-returned' });
    const input = { email: 'customer@example.test', plainPassword: 'example-password-value' };
    const context = { correlationId: 'request-12345678' };

    await expect(service.register(input, context)).resolves.toBeUndefined();

    expect(register).toHaveBeenCalledWith(input, context);
  });

  it('maps only the User normalized-email unique conflict to the generic success path', async () => {
    const { service, register } = createSubject();
    register.mockRejectedValue(
      knownRequestError('P2002', {
        modelName: 'User',
        target: ['emailNormalized'],
      }),
    );

    await expect(
      service.register(
        { email: 'customer@example.test', plainPassword: 'example-password-value' },
        { correlationId: 'request-12345678' },
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    knownRequestError('P2002', { modelName: 'User', target: ['id'] }),
    knownRequestError('P2002', { modelName: 'UserRole', target: ['userId', 'role'] }),
    knownRequestError('P2024', { modelName: 'User' }),
    new Error('Unexpected failure'),
  ])('preserves an unexpected persistence error', async (error) => {
    const { service, register } = createSubject();
    register.mockRejectedValue(error);

    await expect(
      service.register(
        { email: 'customer@example.test', plainPassword: 'example-password-value' },
        { correlationId: 'request-12345678' },
      ),
    ).rejects.toBe(error);
  });
});

describe('isNormalizedEmailConflict', () => {
  it('recognizes the nested driver-adapter constraint shape without matching another field', () => {
    expect(
      isNormalizedEmailConflict(
        knownRequestError('P2002', {
          modelName: 'User',
          driverAdapterError: {
            cause: {
              kind: 'UniqueConstraintViolation',
              constraint: { fields: ['emailNormalized'] },
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      isNormalizedEmailConflict(
        knownRequestError('P2002', {
          modelName: 'User',
          driverAdapterError: {
            cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['id'] } },
          },
        }),
      ),
    ).toBe(false);
  });
});
