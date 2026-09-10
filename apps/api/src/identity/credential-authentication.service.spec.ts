import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { InvalidCredentialsError } from './authentication.errors';
import { CredentialAuthenticationService } from './credential-authentication.service';

describe('CredentialAuthenticationService', () => {
  function createSubject(
    user: {
      id: string;
      emailNormalized: string;
      passwordHash: string;
      status: AccountStatus;
      credentialVersion: number;
      totpSecretCiphertext?: string | null;
      totpEnrolledAt?: Date | null;
      userRoles: Array<{ role: RoleName }>;
    } | null = {
      id: '67b3456e-5303-41e7-9c36-4611ee204811',
      emailNormalized: 'customer@example.test',
      passwordHash: '$argon2id$stored-user-hash',
      status: AccountStatus.ACTIVE,
      credentialVersion: 1,
      totpSecretCiphertext: null,
      totpEnrolledAt: null,
      userRoles: [{ role: RoleName.CUSTOMER }],
    },
  ) {
    const findUnique = jest.fn(async () => user);
    const verify = jest.fn<Promise<boolean>, [string, string]>(async () => true);
    const service = new CredentialAuthenticationService(
      { user: { findUnique } } as never,
      { verify } as never,
    );
    return { service, findUnique, verify };
  }

  it('normalizes the email and returns only the authenticated principal', async () => {
    const { service, findUnique, verify } = createSubject();

    await expect(
      service.authenticate('  CUSTOMER@Example.Test  ', 'plain-password'),
    ).resolves.toEqual({
      id: '67b3456e-5303-41e7-9c36-4611ee204811',
      email: 'customer@example.test',
      roles: [RoleName.CUSTOMER],
      credentialVersion: 1,
      mfaEnrolled: false,
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { emailNormalized: 'customer@example.test' } }),
    );
    expect(verify).toHaveBeenCalledWith('plain-password', '$argon2id$stored-user-hash');
  });

  it('performs one Argon2 verification with a valid dummy hash for an unknown email', async () => {
    const { service, verify } = createSubject(null);

    await expect(service.authenticate('missing@example.test', 'plain-password')).rejects.toEqual(
      new InvalidCredentialsError(),
    );
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[1]).toMatch(/^\$argon2id\$v=19\$m=65536,p=4,t=3\$/);
  });

  it.each([
    ['wrong password', AccountStatus.ACTIVE, false],
    ['pending account', AccountStatus.PENDING_VERIFICATION, true],
    ['suspended account', AccountStatus.SUSPENDED, true],
  ])('returns the same failure for a %s', async (_label, status, passwordMatches) => {
    const { service, verify } = createSubject({
      id: '67b3456e-5303-41e7-9c36-4611ee204811',
      emailNormalized: 'customer@example.test',
      passwordHash: '$argon2id$stored-user-hash',
      status,
      credentialVersion: 1,
      totpSecretCiphertext: null,
      totpEnrolledAt: null,
      userRoles: [{ role: RoleName.CUSTOMER }],
    });
    verify.mockResolvedValueOnce(passwordMatches);

    await expect(service.authenticate('customer@example.test', 'plain-password')).rejects.toEqual(
      new InvalidCredentialsError(),
    );
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('does not expose a malformed stored hash as a different public failure', async () => {
    const { service, verify } = createSubject();
    verify.mockRejectedValueOnce(new Error('malformed encoded hash'));

    await expect(service.authenticate('customer@example.test', 'plain-password')).rejects.toEqual(
      new InvalidCredentialsError(),
    );
  });
});
