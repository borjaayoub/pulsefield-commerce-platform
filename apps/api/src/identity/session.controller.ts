import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import { RoleName } from '../generated/prisma/enums';
import { IdentityThrottlerGuard } from '../rate-limit/identity-throttler.guard';
import {
  IDENTITY_RATE_LIMIT_WINDOW_MS,
  LOGIN_IDENTIFIER_RATE_LIMIT,
  LOGIN_IP_RATE_LIMIT,
} from '../rate-limit/rate-limit.module';
import { BrowserRequestGuard } from './browser-request.guard';
import type { AuthenticatedPrincipal } from './credential-authentication.service';
import { IDENTITY_WEB_ORIGIN } from './identity.constants';
import { LocalAuthGuard } from './local-auth.guard';
import { LoginRequestValidationGuard } from './login-request-validation.guard';
import { normalizeEmail } from './normalize-email';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-cookie';
import {
  type AuthenticatedSessionRequest,
  SessionAuthenticationGuard,
} from './session-authentication.guard';
import { CreateSessionDto, SessionDto } from './session.dto';
import { SessionService, type SessionView } from './session.service';
import { MfaEnrollmentRequiredDto, MfaRequiredDto } from './mfa.dto';
import { MfaService } from './mfa.service';
import { requiresStaffMfa } from './authorization.service';
import { RequireRoles } from './require-roles.decorator';
import { RoleAuthorizationGuard } from './role-authorization.guard';

interface LocalAuthenticatedRequest extends Request {
  user: AuthenticatedPrincipal;
}

async function loginIdentifierTracker(request: Record<string, unknown>): Promise<string> {
  const body = request.body;
  const email =
    typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string'
      ? normalizeEmail(body.email)
      : 'invalid-login-identifier';
  return `email:${email}`;
}

@ApiTags('Identity sessions')
@ApiExtraModels(MfaRequiredDto, MfaEnrollmentRequiredDto)
@Controller('auth/sessions')
@SkipThrottle({ cartAll: true, cartMutation: true })
export class SessionController {
  private readonly secureCookie: boolean;

  constructor(
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    @Inject(IDENTITY_WEB_ORIGIN) webOrigin: string,
  ) {
    this.secureCookie = new URL(webOrigin).protocol === 'https:';
  }

  @Post()
  @UseGuards(
    IdentityThrottlerGuard,
    BrowserRequestGuard,
    LoginRequestValidationGuard,
    LocalAuthGuard,
  )
  @SkipThrottle({
    default: true,
    verificationRequestIdentifier: true,
    passwordRecoveryIdentifier: true,
    mfaChallenge: true,
  })
  @Throttle({
    loginIp: {
      limit: LOGIN_IP_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    },
    loginIdentifier: {
      limit: LOGIN_IDENTIFIER_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
      getTracker: loginIdentifierTracker,
    },
  })
  @ApiBody({ type: CreateSessionDto })
  @ApiCreatedResponse({ type: SessionDto })
  @ApiAcceptedResponse({
    schema: {
      oneOf: [
        { $ref: '#/components/schemas/MfaRequiredDto' },
        { $ref: '#/components/schemas/MfaEnrollmentRequiredDto' },
      ],
    },
  })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async create(
    @Req() request: LocalAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView | MfaRequiredDto | MfaEnrollmentRequiredDto> {
    if (requiresStaffMfa(request.user.roles)) {
      response.status(HttpStatus.ACCEPTED);
      return this.mfa.begin(request.user);
    }
    const created = await this.sessions.create(
      request.user,
      'PASSWORD',
      readSessionCookie(request),
    );
    setSessionCookie(response, created.sessionId, this.secureCookie);
    response.location('/api/v1/auth/sessions/current');
    return created.view;
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(BrowserRequestGuard, SessionAuthenticationGuard, RoleAuthorizationGuard)
  @RequireRoles(RoleName.CUSTOMER, RoleName.FULFILLER, RoleName.ADMINISTRATOR)
  @ApiCookieAuth('session-cookie')
  @ApiNoContentResponse()
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async logoutAll(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.sessions.logoutAll(readSessionCookie(request), request.header('x-csrf-token'));
    clearSessionCookie(response, this.secureCookie);
  }

  @Get('current')
  @UseGuards(SessionAuthenticationGuard, RoleAuthorizationGuard)
  @RequireRoles(RoleName.CUSTOMER, RoleName.FULFILLER, RoleName.ADMINISTRATOR)
  @ApiCookieAuth('session-cookie')
  @ApiOkResponse({ type: SessionDto })
  @ApiResponse({ status: 401, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  current(@Req() request: AuthenticatedSessionRequest): SessionView {
    if (!request.authenticatedSession) {
      throw new Error('The session guard did not attach an authenticated session.');
    }
    return request.authenticatedSession;
  }

  @Delete('current')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth('session-cookie')
  @ApiNoContentResponse()
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.sessions.logout(readSessionCookie(request), request.header('x-csrf-token'));
    clearSessionCookie(response, this.secureCookie);
  }
}
