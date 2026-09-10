import { DynamicModule, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import type { LocalProfile } from '@pulse-field/foundation';
import { IdentityThrottlerGuard } from '../rate-limit/identity-throttler.guard';
import { BrowserRequestGuard } from './browser-request.guard';
import { CredentialAuthenticationService } from './credential-authentication.service';
import { CustomerRegistrationService } from './customer-registration.service';
import { EmailVerificationTokenService } from './email-verification-token.service';
import { EmailVerificationRequestService } from './email-verification-request.service';
import {
  IDENTITY_WEB_ORIGIN,
  MFA_DATA_PROTECTION_KEYS,
  SESSION_REDIS_URL,
} from './identity.constants';
import { LocalAuthGuard } from './local-auth.guard';
import { LocalStrategy } from './local.strategy';
import { LoginRequestValidationGuard } from './login-request-validation.guard';
import { PasswordHasher } from './password-hasher.service';
import { PasswordRecoveryRequestService } from './password-recovery-request.service';
import { PasswordResetTokenService } from './password-reset-token.service';
import { PublicCustomerRegistrationService } from './public-customer-registration.service';
import { PublicIdentityController } from './public-identity.controller';
import { RedisSessionStore } from './redis-session.store';
import { SessionAuthenticationGuard } from './session-authentication.guard';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { MfaChallengeStore } from './mfa-challenge.store';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { TotpSecretProtector } from './totp-secret-protector.service';
import { TotpService } from './totp.service';
import { AuthorizationService } from './authorization.service';
import { RoleAuthorizationGuard } from './role-authorization.guard';
import { RecentStaffAuthenticationGuard } from './recent-staff-authentication.guard';
import { AuditModule } from '../audit/audit.module';
import { StaffRoleController } from './staff-role.controller';
import { StaffRoleManagementService } from './staff-role-management.service';
import { StaffAccountLookupController } from './staff-account-lookup.controller';
import { StaffAccountLookupService } from './staff-account-lookup.service';
import { NotificationDeliveryReplayController } from './notification-delivery-replay.controller';
import { NotificationDeliveryReplayService } from './notification-delivery-replay.service';

@Module({})
export class IdentityModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: IdentityModule,
      global: true,
      imports: [PassportModule.register({ session: false }), AuditModule],
      controllers: [
        PublicIdentityController,
        SessionController,
        MfaController,
        StaffRoleController,
        StaffAccountLookupController,
        NotificationDeliveryReplayController,
      ],
      providers: [
        { provide: IDENTITY_WEB_ORIGIN, useValue: profile.WEB_ORIGIN },
        { provide: SESSION_REDIS_URL, useValue: profile.EPHEMERAL_REDIS_URL },
        {
          provide: MFA_DATA_PROTECTION_KEYS,
          useValue: {
            current: profile.MESSAGE_ENCRYPTION_KEY_BASE64,
            previous: profile.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64,
          },
        },
        MfaChallengeStore,
        MfaService,
        TotpService,
        TotpSecretProtector,
        PasswordHasher,
        PasswordRecoveryRequestService,
        PasswordResetTokenService,
        CustomerRegistrationService,
        EmailVerificationTokenService,
        EmailVerificationRequestService,
        PublicCustomerRegistrationService,
        CredentialAuthenticationService,
        LocalStrategy,
        LocalAuthGuard,
        LoginRequestValidationGuard,
        BrowserRequestGuard,
        IdentityThrottlerGuard,
        RedisSessionStore,
        SessionService,
        SessionAuthenticationGuard,
        AuthorizationService,
        RoleAuthorizationGuard,
        RecentStaffAuthenticationGuard,
        StaffRoleManagementService,
        StaffAccountLookupService,
        NotificationDeliveryReplayService,
      ],
      exports: [
        EmailVerificationTokenService,
        PasswordResetTokenService,
        AuthorizationService,
        RoleAuthorizationGuard,
        RecentStaffAuthenticationGuard,
      ],
    };
  }
}
