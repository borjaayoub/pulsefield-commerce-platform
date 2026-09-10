import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import { IdentityThrottlerGuard } from '../rate-limit/identity-throttler.guard';
import {
  IDENTITY_RATE_LIMIT_WINDOW_MS,
  MFA_CHALLENGE_RATE_LIMIT,
  MFA_IP_RATE_LIMIT,
} from '../rate-limit/rate-limit.module';
import { BrowserRequestGuard } from './browser-request.guard';
import { IDENTITY_WEB_ORIGIN } from './identity.constants';
import {
  CompleteMfaAuthenticationDto,
  CompleteMfaEnrollmentDto,
  CompleteStaffReauthenticationDto,
  MfaEnrolledDto,
} from './mfa.dto';
import { MfaService } from './mfa.service';
import { SessionDto } from './session.dto';
import { readSessionCookie, setSessionCookie } from './session-cookie';
import { SessionService, type SessionView } from './session.service';
import {
  SessionAuthenticationGuard,
  type AuthenticatedSessionRequest,
} from './session-authentication.guard';
import { RoleAuthorizationGuard } from './role-authorization.guard';
import { RequireRoles } from './require-roles.decorator';
import { RoleName } from '../generated/prisma/enums';

function challengeTracker(request: Record<string, unknown>): string {
  const body = request.body;
  const token =
    typeof body === 'object' &&
    body !== null &&
    'challengeToken' in body &&
    typeof body.challengeToken === 'string'
      ? body.challengeToken
      : 'invalid';
  return `challenge:${createHash('sha256').update(token).digest('hex')}`;
}

@ApiTags('Staff MFA')
@Controller('auth')
@UseGuards(IdentityThrottlerGuard, BrowserRequestGuard)
@SkipThrottle({
  loginIp: true,
  loginIdentifier: true,
  verificationRequestIdentifier: true,
  passwordRecoveryIdentifier: true,
  mfaChallenge: false,
})
@Throttle({
  default: {
    limit: MFA_IP_RATE_LIMIT,
    ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
    blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
  },
  mfaChallenge: {
    limit: MFA_CHALLENGE_RATE_LIMIT,
    ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
    blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    getTracker: challengeTracker,
  },
})
export class MfaController {
  private readonly secureCookie: boolean;
  constructor(
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    @Inject(IDENTITY_WEB_ORIGIN) webOrigin: string,
  ) {
    this.secureCookie = new URL(webOrigin).protocol === 'https:';
  }

  @Post('mfa-enrollments')
  @ApiCreatedResponse({ type: MfaEnrolledDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  enroll(@Body() body: CompleteMfaEnrollmentDto): Promise<MfaEnrolledDto> {
    return this.mfa.enroll(body.challengeToken, body.totpCode);
  }

  @Post('mfa-authentications')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: SessionDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async authenticate(
    @Body() body: CompleteMfaAuthenticationDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    const principal = await this.mfa.authenticate(body.challengeToken, {
      totpCode: body.totpCode,
      recoveryCode: body.recoveryCode,
    });
    const created = await this.sessions.create(
      principal,
      'PASSWORD_MFA',
      readSessionCookie(request),
    );
    setSessionCookie(response, created.sessionId, this.secureCookie);
    response.location('/api/v1/auth/sessions/current');
    return created.view;
  }

  @Post('reauthentications')
  @SkipThrottle({ mfaChallenge: true })
  @UseGuards(SessionAuthenticationGuard, RoleAuthorizationGuard)
  @RequireRoles(RoleName.ADMINISTRATOR, RoleName.FULFILLER)
  @ApiCookieAuth('session-cookie')
  @ApiCreatedResponse({ type: SessionDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async reauthenticate(
    @Body() body: CompleteStaffReauthenticationDto,
    @Req() request: AuthenticatedSessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    const current = request.authenticatedSession;
    if (!current) throw new Error('The session guard did not attach an authenticated session.');
    this.sessions.assertCsrf(current, request.header('x-csrf-token'));
    const principal = await this.mfa.reauthenticate(current.user.id, body);
    const created = await this.sessions.create(
      principal,
      'PASSWORD_MFA',
      readSessionCookie(request),
    );
    setSessionCookie(response, created.sessionId, this.secureCookie);
    response.location('/api/v1/auth/sessions/current');
    return created.view;
  }
}
