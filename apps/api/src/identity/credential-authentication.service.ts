import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, type RoleName } from '../generated/prisma/enums';
import { InvalidCredentialsError } from './authentication.errors';
import { normalizeEmail } from './normalize-email';
import { PasswordHasher } from './password-hasher.service';

// This is a real Argon2id encoding for a non-secret dummy value. It makes the
// nonexistent-user path perform the same expensive verification operation.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$u1i6T8369OnBYxKcVvQmLw$72KNCcktFPhBQkFXxLccKhmrx4DlxyUDDB4MajDWVsI';

export interface AuthenticatedPrincipal {
  id: string;
  email: string;
  roles: RoleName[];
  credentialVersion: number;
  mfaEnrolled: boolean;
}

@Injectable()
export class CredentialAuthenticationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async authenticate(email: string, plainPassword: string): Promise<AuthenticatedPrincipal> {
    const emailNormalized = normalizeEmail(email);
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized },
      select: {
        id: true,
        emailNormalized: true,
        passwordHash: true,
        credentialVersion: true,
        totpSecretCiphertext: true,
        totpEnrolledAt: true,
        status: true,
        userRoles: { select: { role: true } },
      },
    });

    let passwordMatches = false;
    try {
      passwordMatches = await this.passwordHasher.verify(
        plainPassword,
        user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      );
    } catch {
      passwordMatches = false;
    }

    if (!user || !passwordMatches || user.status !== AccountStatus.ACTIVE) {
      throw new InvalidCredentialsError();
    }

    return {
      id: user.id,
      email: user.emailNormalized,
      roles: user.userRoles.map(({ role }) => role),
      credentialVersion: user.credentialVersion,
      mfaEnrolled: Boolean(user.totpSecretCiphertext && user.totpEnrolledAt),
    };
  }
}
