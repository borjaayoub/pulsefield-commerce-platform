import { PrismaService } from '../database/prisma.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import {
  CUSTOMER_REGISTERED_EVENT_TYPE,
  CUSTOMER_REGISTERED_EVENT_VERSION,
  CustomerRegistrationService,
  type CustomerRegistrationResult,
} from './customer-registration.service';
import { PasswordHasher } from './password-hasher.service';

describe('CustomerRegistrationService', () => {
  const createdAt = new Date('2026-08-31T12:00:00.000Z');
  const storedUser = {
    id: 'f3aa0ff3-7da2-462f-a5a9-c82cb8402c59',
    emailNormalized: 'ayoub.exampleshop@example.com',
    status: AccountStatus.PENDING_VERIFICATION,
    createdAt,
    userRoles: [{ role: RoleName.CUSTOMER }],
  };

  function createSubject(): {
    service: CustomerRegistrationService;
    hash: jest.Mock<Promise<string>, [string]>;
    createUser: jest.Mock<Promise<typeof storedUser>, [unknown]>;
    createOutbox: jest.Mock<Promise<{ id: string }>, [unknown]>;
    runTransaction: jest.Mock<Promise<unknown>, [(transaction: unknown) => Promise<unknown>]>;
  } {
    const hash = jest.fn<Promise<string>, [string]>();
    const createUser = jest.fn<Promise<typeof storedUser>, [unknown]>();
    const createOutbox = jest.fn<Promise<{ id: string }>, [unknown]>();
    const transaction = {
      user: { create: createUser },
      outboxMessage: { create: createOutbox },
    };
    const runTransaction = jest.fn<Promise<unknown>, [(transaction: unknown) => Promise<unknown>]>(
      (operation) => operation(transaction),
    );
    const passwordHasher = {
      hash,
      verify: jest.fn(),
    } as unknown as PasswordHasher;
    const prisma = {
      $transaction: runTransaction,
    } as unknown as PrismaService;

    hash.mockResolvedValue('encoded-argon2id-hash');
    createUser.mockResolvedValue(storedUser);
    createOutbox.mockResolvedValue({ id: '06f49d8c-87db-43ab-8ae9-9468cf4f8083' });

    return {
      service: new CustomerRegistrationService(passwordHasher, prisma),
      hash,
      createUser,
      createOutbox,
      runTransaction,
    };
  }

  it('normalizes the email, hashes the password, and sends one nested account write', async () => {
    // Arrange
    const { service, hash, createUser } = createSubject();

    // Act
    await service.register({
      email: '  Ayoub.ExampleShop@Example.COM  ',
      plainPassword: 'example-password',
    });

    // Assert
    expect(hash).toHaveBeenCalledWith('example-password');
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith({
      data: {
        emailNormalized: 'ayoub.exampleshop@example.com',
        passwordHash: 'encoded-argon2id-hash',
        status: AccountStatus.PENDING_VERIFICATION,
        verificationEmailRequestedAt: expect.any(Date),
        userRoles: {
          create: {
            role: RoleName.CUSTOMER,
          },
        },
      },
      select: {
        id: true,
        emailNormalized: true,
        status: true,
        createdAt: true,
        userRoles: {
          select: {
            role: true,
          },
        },
      },
    });
  });

  it('returns only the safe customer registration result', async () => {
    // Arrange
    const { service } = createSubject();

    // Act
    const result = await service.register({
      email: 'ayoub.exampleshop@example.com',
      plainPassword: 'example-password',
    });

    // Assert
    expect(result).toEqual<CustomerRegistrationResult>({
      id: storedUser.id,
      emailNormalized: storedUser.emailNormalized,
      status: AccountStatus.PENDING_VERIFICATION,
      roles: [RoleName.CUSTOMER],
      createdAt,
    });
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('creates a versioned outbox event in the same transaction without secret data', async () => {
    // Arrange
    const { service, createOutbox, runTransaction } = createSubject();

    // Act
    await service.register(
      {
        email: 'ayoub.exampleshop@example.com',
        plainPassword: 'example-password',
      },
      {
        correlationId: 'request-12345678',
        causationId: 'command-12345678',
      },
    );

    // Assert
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(createOutbox).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        eventType: CUSTOMER_REGISTERED_EVENT_TYPE,
        eventVersion: CUSTOMER_REGISTERED_EVENT_VERSION,
        aggregateType: 'User',
        aggregateId: storedUser.id,
        payload: { userId: storedUser.id },
        correlationId: 'request-12345678',
        causationId: 'command-12345678',
      },
    });
    expect(JSON.stringify(createOutbox.mock.calls[0])).not.toContain('example-password');
    expect(JSON.stringify(createOutbox.mock.calls[0])).not.toContain(storedUser.emailNormalized);
  });

  it('does not write to the database when password hashing fails', async () => {
    // Arrange
    const { service, hash, createUser, runTransaction } = createSubject();
    hash.mockRejectedValue(new Error('Hashing failed'));

    // Act and Assert
    await expect(
      service.register({
        email: 'ayoub.exampleshop@example.com',
        plainPassword: 'example-password',
      }),
    ).rejects.toThrow('Hashing failed');
    expect(createUser).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('normalizes the password before hashing', async () => {
    // Arrange
    const { service, hash } = createSubject();

    // Act
    await service.register({
      email: 'ayoub.exampleshop@example.com',
      plainPassword: 'Cafe\u0301 password phrase',
    });

    // Assert
    expect(hash).toHaveBeenCalledWith('Café password phrase');
  });

  it('does not hash or write a password rejected by policy', async () => {
    // Arrange
    const { service, hash, createUser, runTransaction } = createSubject();

    // Act and Assert
    await expect(
      service.register({
        email: 'ayoub.exampleshop@example.com',
        plainPassword: 'too-short',
      }),
    ).rejects.toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
    expect(hash).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects a password matching the account email local part', async () => {
    // Arrange
    const { service, hash, createUser, runTransaction } = createSubject();

    // Act and Assert
    await expect(
      service.register({
        email: 'Ayoub.ExampleShop@example.com',
        plainPassword: 'ayoub.exampleshop',
      }),
    ).rejects.toMatchObject({ code: 'PASSWORD_BLOCKLISTED' });
    expect(hash).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });
});
