import { Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, type RoleName } from '../generated/prisma/enums';
import type { AuthenticatedPrincipal } from './credential-authentication.service';
import { requiresStaffMfa, roleFingerprint } from './authorization.service';
import {
  InvalidCsrfTokenError,
  SessionStoreUnavailableError,
  UnauthenticatedError,
} from './authentication.errors';
import {
  type AuthenticationAssurance,
  type CreatedSession,
  RedisSessionStore,
  type SessionRecord,
} from './redis-session.store';

export interface SessionView {
  user: {
    id: string;
    email: string;
    roles: RoleName[];
  };
  authenticatedAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  csrfToken: string;
}

export interface NewSession {
  sessionId: string;
  view: SessionView;
}

function view(record: SessionRecord, principal: AuthenticatedPrincipal): SessionView {
  return {
    user: {
      id: principal.id,
      email: principal.email,
      roles: principal.roles,
    },
    authenticatedAt: new Date(record.authenticatedAt).toISOString(),
    idleExpiresAt: new Date(record.idleExpiresAt).toISOString(),
    absoluteExpiresAt: new Date(record.absoluteExpiresAt).toISOString(),
    csrfToken: record.csrfToken,
  };
}

function csrfMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string') {
    return false;
  }

  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
  );
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly store: RedisSessionStore,
    private readonly prisma: PrismaService,
  ) {}

  async create(
    principal: AuthenticatedPrincipal,
    authenticationAssurance: AuthenticationAssurance,
    previousSessionId?: string,
  ): Promise<NewSession> {
    const created: CreatedSession = await this.store.create(
      principal.id,
      principal.credentialVersion,
      authenticationAssurance,
      roleFingerprint(principal.roles),
      previousSessionId,
    );
    return { sessionId: created.sessionId, view: view(created.record, principal) };
  }

  async current(sessionId: string): Promise<SessionView> {
    const record = await this.store.readAndRefresh(sessionId);
    if (!record) {
      throw new UnauthenticatedError();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      select: {
        id: true,
        emailNormalized: true,
        status: true,
        credentialVersion: true,
        totpEnrolledAt: true,
        userRoles: { select: { role: true } },
      },
    });

    const roles = user?.userRoles.map(({ role }) => role) ?? [];
    if (
      !user ||
      user.status !== AccountStatus.ACTIVE ||
      user.credentialVersion !== record.credentialVersion ||
      roleFingerprint(roles) !== record.roleFingerprint ||
      (requiresStaffMfa(roles) &&
        (record.authenticationAssurance !== 'PASSWORD_MFA' || user.totpEnrolledAt === null))
    ) {
      await this.store.revoke(sessionId);
      throw new UnauthenticatedError();
    }

    return view(record, {
      id: user.id,
      email: user.emailNormalized,
      roles,
      credentialVersion: user.credentialVersion,
      mfaEnrolled: user.totpEnrolledAt !== null,
    });
  }

  async logout(sessionId: string | undefined, csrfToken: string | undefined): Promise<void> {
    if (!sessionId) {
      return;
    }

    const record = await this.store.peek(sessionId);
    if (!record) {
      return;
    }

    if (!csrfMatches(csrfToken, record.csrfToken)) {
      throw new InvalidCsrfTokenError();
    }

    await this.store.revoke(sessionId);
  }

  assertCsrf(session: SessionView, csrfToken: string | undefined): void {
    if (!csrfMatches(csrfToken, session.csrfToken)) {
      throw new InvalidCsrfTokenError();
    }
  }

  async logoutAll(sessionId: string | undefined, csrfToken: string | undefined): Promise<void> {
    if (!sessionId) {
      throw new UnauthenticatedError();
    }

    const record = await this.store.peek(sessionId);
    if (!record) {
      throw new UnauthenticatedError();
    }

    if (!csrfMatches(csrfToken, record.csrfToken)) {
      throw new InvalidCsrfTokenError();
    }

    await this.prisma.user.updateMany({
      where: {
        id: record.userId,
        status: AccountStatus.ACTIVE,
        credentialVersion: record.credentialVersion,
      },
      data: { credentialVersion: { increment: 1 } },
    });

    try {
      await this.store.revoke(sessionId);
    } catch (error) {
      if (!(error instanceof SessionStoreUnavailableError)) {
        throw error;
      }
      this.logger.warn('Current session cleanup was deferred after account-wide revocation.');
    }
  }
}
