import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import { IdentityThrottlerGuard } from '../rate-limit/identity-throttler.guard';
import {
  EMAIL_VERIFICATION_RATE_LIMIT,
  EMAIL_VERIFICATION_REQUEST_IDENTIFIER_RATE_LIMIT,
  EMAIL_VERIFICATION_REQUEST_IP_RATE_LIMIT,
  IDENTITY_RATE_LIMIT_WINDOW_MS,
  PASSWORD_RECOVERY_REQUEST_IDENTIFIER_RATE_LIMIT,
  PASSWORD_RECOVERY_REQUEST_IP_RATE_LIMIT,
  PASSWORD_RESET_IP_RATE_LIMIT,
  REGISTRATION_RATE_LIMIT,
} from '../rate-limit/rate-limit.module';
import { EmailVerificationTokenService } from './email-verification-token.service';
import { BrowserRequestGuard } from './browser-request.guard';
import { EmailVerificationRequestService } from './email-verification-request.service';
import { normalizeEmail } from './normalize-email';
import { PasswordRecoveryRequestService } from './password-recovery-request.service';
import { PasswordResetTokenService } from './password-reset-token.service';
import {
  PasswordRecoveryRequestAcceptedDto,
  RegisterCustomerDto,
  RegistrationAcceptedDto,
  RequestPasswordRecoveryDto,
  RequestEmailVerificationDto,
  ResetPasswordDto,
  VerificationRequestAcceptedDto,
  VerifyEmailDto,
} from './public-identity.dto';
import { PublicCustomerRegistrationService } from './public-customer-registration.service';

@ApiTags('Identity')
@Controller('auth')
@UseGuards(IdentityThrottlerGuard)
@SkipThrottle({
  cartAll: true,
  cartMutation: true,
  loginIp: true,
  loginIdentifier: true,
  verificationRequestIdentifier: true,
  passwordRecoveryIdentifier: true,
  mfaChallenge: true,
})
export class PublicIdentityController {
  constructor(
    private readonly registrations: PublicCustomerRegistrationService,
    private readonly verificationTokens: EmailVerificationTokenService,
    private readonly verificationRequests: EmailVerificationRequestService,
    private readonly passwordRecoveryRequests: PasswordRecoveryRequestService,
    private readonly passwordResetTokens: PasswordResetTokenService,
  ) {}

  @Post('password-recovery-requests')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(BrowserRequestGuard)
  @SkipThrottle({
    loginIp: true,
    loginIdentifier: true,
    verificationRequestIdentifier: true,
    passwordRecoveryIdentifier: false,
  })
  @Throttle({
    default: {
      limit: PASSWORD_RECOVERY_REQUEST_IP_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    },
    passwordRecoveryIdentifier: {
      limit: PASSWORD_RECOVERY_REQUEST_IDENTIFIER_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
      getTracker: async (request: Record<string, unknown>) => {
        const body = request.body;
        const email =
          typeof body === 'object' &&
          body !== null &&
          'email' in body &&
          typeof body.email === 'string'
            ? normalizeEmail(body.email)
            : 'invalid-recovery-identifier';
        return `email:${email}`;
      },
    },
  })
  @ApiAcceptedResponse({ type: PasswordRecoveryRequestAcceptedDto })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async requestPasswordRecovery(
    @Body() body: RequestPasswordRecoveryDto,
    @Req() request: Request,
  ): Promise<PasswordRecoveryRequestAcceptedDto> {
    await this.passwordRecoveryRequests.request(body.email, {
      correlationId: request.header('x-request-id'),
    });

    return { status: 'REQUEST_ACCEPTED' };
  }

  @Post('password-resets')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(BrowserRequestGuard)
  @SkipThrottle({
    loginIp: true,
    loginIdentifier: true,
    verificationRequestIdentifier: true,
    passwordRecoveryIdentifier: true,
  })
  @Throttle({
    default: {
      limit: PASSWORD_RESET_IP_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    },
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiUnprocessableEntityResponse({ type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    await this.passwordResetTokens.reset(body.token, body.newPassword);
  }

  @Post('email-verification-requests')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(BrowserRequestGuard)
  @SkipThrottle({
    loginIp: true,
    loginIdentifier: true,
    verificationRequestIdentifier: false,
  })
  @Throttle({
    default: {
      limit: EMAIL_VERIFICATION_REQUEST_IP_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    },
    verificationRequestIdentifier: {
      limit: EMAIL_VERIFICATION_REQUEST_IDENTIFIER_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
      getTracker: async (request: Record<string, unknown>) => {
        const body = request.body;
        const email =
          typeof body === 'object' &&
          body !== null &&
          'email' in body &&
          typeof body.email === 'string'
            ? normalizeEmail(body.email)
            : 'invalid-verification-identifier';
        return `email:${email}`;
      },
    },
  })
  @ApiAcceptedResponse({ type: VerificationRequestAcceptedDto })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiResponse({ status: 403, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async requestEmailVerification(
    @Body() body: RequestEmailVerificationDto,
    @Req() request: Request,
  ): Promise<VerificationRequestAcceptedDto> {
    await this.verificationRequests.request(body.email, {
      correlationId: request.header('x-request-id'),
    });

    return { status: 'REQUEST_ACCEPTED' };
  }

  @Post('registrations')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({
    default: {
      limit: REGISTRATION_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    },
  })
  @ApiAcceptedResponse({ type: RegistrationAcceptedDto })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiUnprocessableEntityResponse({ type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async register(
    @Body() body: RegisterCustomerDto,
    @Req() request: Request,
  ): Promise<RegistrationAcceptedDto> {
    await this.registrations.register(
      { email: body.email, plainPassword: body.password },
      { correlationId: request.header('x-request-id') },
    );

    return { status: 'VERIFICATION_REQUIRED' };
  }

  @Post('email-verifications')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({
    default: {
      limit: EMAIL_VERIFICATION_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    },
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async verifyEmail(@Body() body: VerifyEmailDto): Promise<void> {
    await this.verificationTokens.consume(body.token);
  }
}
