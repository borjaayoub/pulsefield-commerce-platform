import { validateLocalProfile } from '@pulse-field/foundation';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { createApiApp } from './create-api-app';
import {
  InvalidCredentialsError,
  InvalidCsrfTokenError,
  MfaAuthenticationFailedError,
} from './identity/authentication.errors';
import { CredentialAuthenticationService } from './identity/credential-authentication.service';
import { InvalidEmailVerificationTokenError } from './identity/email-verification-token.service';
import { EmailVerificationTokenService } from './identity/email-verification-token.service';
import { EmailVerificationRequestService } from './identity/email-verification-request.service';
import { PasswordRecoveryRequestService } from './identity/password-recovery-request.service';
import {
  InvalidPasswordResetTokenError,
  PasswordResetTokenService,
} from './identity/password-reset-token.service';
import { SESSION_COOKIE_NAME } from './identity/identity.constants';
import { MfaService } from './identity/mfa.service';
import { PasswordPolicyError } from './identity/password-policy';
import { PublicCustomerRegistrationService } from './identity/public-customer-registration.service';
import { SessionService } from './identity/session.service';
import { StaffRoleManagementService } from './identity/staff-role-management.service';
import { StaffAccountLookupService } from './identity/staff-account-lookup.service';
import { NotificationDeliveryReplayService } from './identity/notification-delivery-replay.service';
import { RateLimitStorageUnavailableError } from './rate-limit/rate-limit.errors';
import { RedisThrottlerStorage } from './rate-limit/redis-throttler.storage';

const profile = validateLocalProfile({
  LOCAL_DEVELOPMENT_PROFILE: 'zero-cost-local',
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://pulsefield:password@localhost:5432/pulsefield',
  QUEUE_REDIS_URL: 'redis://localhost:6379/0',
  EPHEMERAL_REDIS_URL: 'redis://localhost:6380/0',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_ALLOW_EXTERNAL: 'false',
  MESSAGE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  OUTBOX_RELAY_ENABLED: 'false',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  PRODUCT_MEDIA_ROOT: './.local/media',
  WEB_ORIGIN: 'http://localhost:3000',
  API_PORT: '4000',
  WORKER_PORT: '4001',
  PAYMENT_PROVIDER: 'stub',
  STRIPE_ENABLED: 'false',
  BILLABLE_ADAPTERS_ENABLED: 'false',
});

describe('API foundation', () => {
  let app: NestExpressApplication;
  const sessionId = Buffer.alloc(32, 3).toString('base64url');
  const csrfToken = Buffer.alloc(32, 5).toString('base64url');
  const sessionView = {
    user: {
      id: '67b3456e-5303-41e7-9c36-4611ee204811',
      email: 'customer@example.test',
      roles: ['CUSTOMER' as const],
    },
    authenticatedAt: '2026-09-02T10:00:00.000Z',
    idleExpiresAt: '2026-09-02T10:30:00.000Z',
    absoluteExpiresAt: '2026-09-03T10:00:00.000Z',
    csrfToken,
  };
  const authenticatedPrincipal = { ...sessionView.user, credentialVersion: 1, mfaEnrolled: false };
  const register = jest.spyOn(PublicCustomerRegistrationService.prototype, 'register');
  const consumeToken = jest.spyOn(EmailVerificationTokenService.prototype, 'consume');
  const requestVerification = jest.spyOn(EmailVerificationRequestService.prototype, 'request');
  const requestRecovery = jest.spyOn(PasswordRecoveryRequestService.prototype, 'request');
  const resetPassword = jest.spyOn(PasswordResetTokenService.prototype, 'reset');
  const authenticate = jest.spyOn(CredentialAuthenticationService.prototype, 'authenticate');
  const createSession = jest.spyOn(SessionService.prototype, 'create');
  const currentSession = jest.spyOn(SessionService.prototype, 'current');
  const logout = jest.spyOn(SessionService.prototype, 'logout');
  const logoutAll = jest.spyOn(SessionService.prototype, 'logoutAll');
  const beginMfa = jest.spyOn(MfaService.prototype, 'begin');
  const enrollMfa = jest.spyOn(MfaService.prototype, 'enroll');
  const authenticateMfa = jest.spyOn(MfaService.prototype, 'authenticate');
  const reauthenticateMfa = jest.spyOn(MfaService.prototype, 'reauthenticate');
  const grantStaffRole = jest.spyOn(StaffRoleManagementService.prototype, 'grant');
  const revokeStaffRole = jest.spyOn(StaffRoleManagementService.prototype, 'revoke');
  const lookupStaffAccount = jest.spyOn(StaffAccountLookupService.prototype, 'findByEmail');
  const replayNotificationDelivery = jest.spyOn(
    NotificationDeliveryReplayService.prototype,
    'replay',
  );
  const incrementRateLimit = jest.spyOn(RedisThrottlerStorage.prototype, 'increment');
  const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  beforeAll(async () => {
    app = await createApiApp(profile);
    await app.init();
  });

  beforeEach(() => {
    register.mockReset().mockResolvedValue(undefined);
    consumeToken.mockReset().mockResolvedValue({
      userId: '67b3456e-5303-41e7-9c36-4611ee204811',
      verifiedAt: new Date('2026-09-02T12:00:00.000Z'),
    });
    requestVerification.mockReset().mockResolvedValue(undefined);
    requestRecovery.mockReset().mockResolvedValue(undefined);
    resetPassword.mockReset().mockResolvedValue({
      userId: sessionView.user.id,
      credentialVersion: 2,
    });
    authenticate.mockReset().mockResolvedValue(authenticatedPrincipal);
    createSession.mockReset().mockResolvedValue({ sessionId, view: sessionView });
    currentSession.mockReset().mockResolvedValue(sessionView);
    logout.mockReset().mockResolvedValue(undefined);
    logoutAll.mockReset().mockResolvedValue(undefined);
    beginMfa.mockReset().mockResolvedValue({
      status: 'MFA_REQUIRED',
      challengeToken: Buffer.alloc(32, 7).toString('base64url'),
      expiresAt: '2026-09-02T10:05:00.000Z',
    });
    enrollMfa.mockReset().mockResolvedValue({
      status: 'MFA_ENROLLED',
      recoveryCodes: ['ABCDE-12345-ABCDE-12345'],
    });
    authenticateMfa.mockReset().mockResolvedValue({
      ...authenticatedPrincipal,
      roles: ['FULFILLER'],
      mfaEnrolled: true,
    });
    reauthenticateMfa.mockReset().mockResolvedValue({
      ...authenticatedPrincipal,
      roles: ['ADMINISTRATOR'],
      mfaEnrolled: true,
    });
    grantStaffRole.mockReset().mockResolvedValue({
      userId: '1c41ff8c-f6a9-4e8e-af74-2768909e20c4',
      roles: ['CUSTOMER', 'FULFILLER'],
    });
    revokeStaffRole.mockReset().mockResolvedValue({
      userId: '1c41ff8c-f6a9-4e8e-af74-2768909e20c4',
      roles: ['CUSTOMER'],
    });
    lookupStaffAccount.mockReset().mockResolvedValue({
      userId: '1c41ff8c-f6a9-4e8e-af74-2768909e20c4',
      emailMasked: 'a***@e***.com',
      status: 'ACTIVE',
      verified: true,
      roles: ['CUSTOMER'],
    });
    replayNotificationDelivery.mockReset().mockResolvedValue({
      deliveryId: '1c41ff8c-f6a9-4e8e-af74-2768909e20c4',
      replayEventId: 'e6a4e676-9e91-4679-80d4-b4d98cacb64c',
    });
    incrementRateLimit.mockReset().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 900,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  afterAll(async () => {
    await app.close();
    register.mockRestore();
    consumeToken.mockRestore();
    requestVerification.mockRestore();
    requestRecovery.mockRestore();
    resetPassword.mockRestore();
    authenticate.mockRestore();
    createSession.mockRestore();
    currentSession.mockRestore();
    logout.mockRestore();
    logoutAll.mockRestore();
    beginMfa.mockRestore();
    enrollMfa.mockRestore();
    authenticateMfa.mockRestore();
    reauthenticateMfa.mockRestore();
    grantStaffRole.mockRestore();
    revokeStaffRole.mockRestore();
    lookupStaffAccount.mockRestore();
    replayNotificationDelivery.mockRestore();
    incrementRateLimit.mockRestore();
    logError.mockRestore();
  });

  it('serves a versioned health endpoint with baseline security headers', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', version: 'v1' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('returns one safe accepted contract and forwards the request ID for registration', async () => {
    const plainPassword = 'a-safe-example-passphrase';
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/registrations')
      .set('x-request-id', 'registration-request-123')
      .send({ email: '  CUSTOMER@Example.Test  ', password: plainPassword });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'VERIFICATION_REQUIRED' });
    expect(response.headers['x-request-id']).toBe('registration-request-123');
    expect(JSON.stringify(response.body)).not.toContain(plainPassword);
    expect(JSON.stringify(response.body)).not.toContain('CUSTOMER@Example.Test');
    expect(register).toHaveBeenCalledWith(
      {
        email: 'CUSTOMER@Example.Test',
        plainPassword,
      },
      { correlationId: 'registration-request-123' },
    );
  });

  it('returns Problem Details for unknown fields without echoing their values', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/registrations').send({
      email: 'customer@example.test',
      password: 'a-safe-example-passphrase',
      role: 'ADMINISTRATOR',
    });

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      status: 400,
      code: 'REQUEST_VALIDATION_FAILED',
      instance: '/api/v1/auth/registrations',
    });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
    expect(JSON.stringify(response.body)).not.toContain('ADMINISTRATOR');
    expect(register).not.toHaveBeenCalled();
  });

  it('maps password-policy failures without exposing the submitted password', async () => {
    const plainPassword = 's3cr3t';
    register.mockRejectedValueOnce(new PasswordPolicyError('PASSWORD_TOO_SHORT'));

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/registrations')
      .send({ email: 'customer@example.test', password: plainPassword });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 422,
      code: 'PASSWORD_TOO_SHORT',
      detail: 'Password must contain at least 15 characters.',
    });
    expect(JSON.stringify(response.body)).not.toContain(plainPassword);
  });

  it('consumes a verification credential without returning it', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url');
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/email-verifications')
      .send({ token });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(consumeToken).toHaveBeenCalledWith(token);
  });

  it('accepts a verification-email request without exposing account state', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/email-verification-requests')
      .set('origin', 'http://localhost:3000')
      .set('x-request-id', 'verification-request-123')
      .send({ email: '  CUSTOMER@Example.Test  ' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'REQUEST_ACCEPTED' });
    expect(response.headers['x-request-id']).toBe('verification-request-123');
    expect(JSON.stringify(response.body)).not.toContain('CUSTOMER@Example.Test');
    expect(requestVerification).toHaveBeenCalledWith('CUSTOMER@Example.Test', {
      correlationId: 'verification-request-123',
    });
    expect(incrementRateLimit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(incrementRateLimit.mock.calls)).not.toContain('customer@example.test');
  });

  it('rejects malformed verification-email requests before orchestration', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/email-verification-requests')
      .send({ email: 'not-an-email', role: 'ADMINISTRATOR' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' });
    expect(JSON.stringify(response.body)).not.toContain('ADMINISTRATOR');
    expect(requestVerification).not.toHaveBeenCalled();
  });

  it('rejects cross-site verification-email requests', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/email-verification-requests')
      .set('origin', 'http://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .send({ email: 'customer@example.test' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'CROSS_SITE_REQUEST_REJECTED' });
    expect(requestVerification).not.toHaveBeenCalled();
  });

  it('accepts a password-recovery request without exposing account state', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/password-recovery-requests')
      .set('origin', 'http://localhost:3000')
      .set('x-request-id', 'recovery-request-123')
      .send({ email: '  CUSTOMER@Example.Test  ' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'REQUEST_ACCEPTED' });
    expect(response.headers['x-request-id']).toBe('recovery-request-123');
    expect(JSON.stringify(response.body)).not.toContain('CUSTOMER@Example.Test');
    expect(requestRecovery).toHaveBeenCalledWith('CUSTOMER@Example.Test', {
      correlationId: 'recovery-request-123',
    });
    expect(incrementRateLimit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(incrementRateLimit.mock.calls)).not.toContain('customer@example.test');
  });

  it('resets a password without returning either credential', async () => {
    const token = Buffer.alloc(32, 9).toString('base64url');
    const newPassword = 'a-brand-new-password';
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/password-resets')
      .set('origin', 'http://localhost:3000')
      .send({ token, newPassword });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(resetPassword).toHaveBeenCalledWith(token, newPassword);
    expect(incrementRateLimit).toHaveBeenCalledTimes(1);
  });

  it('returns one safe problem for an invalid password-reset credential', async () => {
    const token = Buffer.alloc(32, 10).toString('base64url');
    resetPassword.mockRejectedValueOnce(new InvalidPasswordResetTokenError());
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/password-resets')
      .send({ token, newPassword: 'a-brand-new-password' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_PASSWORD_RESET_TOKEN',
      detail: 'Password reset token is invalid or unavailable.',
    });
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it('rejects cross-site recovery and password-reset requests', async () => {
    const recovery = await request(app.getHttpServer())
      .post('/api/v1/auth/password-recovery-requests')
      .set('origin', 'http://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .send({ email: 'customer@example.test' });
    const reset = await request(app.getHttpServer())
      .post('/api/v1/auth/password-resets')
      .set('origin', 'http://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .send({
        token: Buffer.alloc(32, 11).toString('base64url'),
        newPassword: 'new-password-value',
      });

    expect(recovery.status).toBe(403);
    expect(reset.status).toBe(403);
    expect(requestRecovery).not.toHaveBeenCalled();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', { token: Buffer.alloc(32, 8).toString('base64url') }],
    ['missing', {}],
  ])('returns the same safe invalid-token problem for an %s credential', async (kind, body) => {
    if (kind === 'unavailable') {
      consumeToken.mockRejectedValueOnce(new InvalidEmailVerificationTokenError());
    }

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/email-verifications')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      status: 400,
      code: 'INVALID_EMAIL_VERIFICATION_TOKEN',
      detail: 'Email verification token is invalid or unavailable.',
    });
    if ('token' in body) {
      expect(JSON.stringify(response.body)).not.toContain(body.token);
    }
  });

  it('returns Retry-After and a safe Problem Details body when the route limit is exceeded', async () => {
    incrementRateLimit.mockResolvedValueOnce({
      totalHits: 6,
      timeToExpire: 700,
      isBlocked: true,
      timeToBlockExpire: 900,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/registrations')
      .send({ email: 'customer@example.test', password: 'a-safe-example-passphrase' });

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('900');
    expect(response.body).toMatchObject({ status: 429, code: 'RATE_LIMIT_EXCEEDED' });
    expect(register).not.toHaveBeenCalled();
  });

  it('fails the protected route closed when shared Redis is unavailable', async () => {
    incrementRateLimit.mockRejectedValueOnce(new RateLimitStorageUnavailableError());

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/registrations')
      .send({ email: 'customer@example.test', password: 'a-safe-example-passphrase' });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 503,
      code: 'RATE_LIMIT_STORAGE_UNAVAILABLE',
    });
    expect(register).not.toHaveBeenCalled();
  });

  it('allows the configured web origin to preflight POST requests', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/auth/registrations')
      .set('origin', 'http://localhost:3000')
      .set('access-control-request-method', 'POST');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
  });

  it('creates an opaque server-side session with the required cookie contract', async () => {
    const plainPassword = 'a-safe-example-passphrase';
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('origin', 'http://localhost:3000')
      .send({ email: '  CUSTOMER@Example.Test  ', password: plainPassword });

    expect(response.status).toBe(201);
    expect(response.headers.location).toBe('/api/v1/auth/sessions/current');
    expect(response.body).toEqual(sessionView);
    expect(response.body).not.toHaveProperty('sessionId');
    expect(JSON.stringify(response.body)).not.toContain(plainPassword);
    const setCookie = response.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${sessionId}`);
    expect(setCookie).toContain('Path=/api/v1');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=86400');
    expect(setCookie).not.toContain('Secure');
    expect(authenticate).toHaveBeenCalledWith('CUSTOMER@Example.Test', plainPassword);
    expect(createSession).toHaveBeenCalledWith(authenticatedPrincipal, 'PASSWORD', undefined);
    expect(incrementRateLimit).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed login input before checking credentials', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/sessions').send({
      email: 'customer@example.test',
      password: 'a-safe-example-passphrase',
      role: 'ADMINISTRATOR',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'REQUEST_VALIDATION_FAILED' });
    expect(authenticate).not.toHaveBeenCalled();
    expect(incrementRateLimit).toHaveBeenCalledTimes(2);
  });

  it('returns one generic credential failure without exposing the submitted values', async () => {
    authenticate.mockRejectedValueOnce(new InvalidCredentialsError());
    const plainPassword = 'incorrect-password';

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .send({ email: 'missing@example.test', password: plainPassword });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(JSON.stringify(response.body)).not.toContain('missing@example.test');
    expect(JSON.stringify(response.body)).not.toContain(plainPassword);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects browser login requests from another site', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('origin', 'http://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .send({ email: 'customer@example.test', password: 'a-safe-example-passphrase' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'CROSS_SITE_REQUEST_REJECTED' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('requires an MFA challenge instead of creating a session after staff password login', async () => {
    const staffPrincipal = {
      ...authenticatedPrincipal,
      roles: ['FULFILLER' as const],
      mfaEnrolled: true,
    };
    authenticate.mockResolvedValueOnce(staffPrincipal);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('origin', 'http://localhost:3000')
      .send({ email: 'staff@example.test', password: 'a-safe-example-passphrase' });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: 'MFA_REQUIRED',
      challengeToken: Buffer.alloc(32, 7).toString('base64url'),
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(beginMfa).toHaveBeenCalledWith(staffPrincipal);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('returns a one-time enrollment secret for staff who have not enrolled yet', async () => {
    const staffPrincipal = {
      ...authenticatedPrincipal,
      roles: ['ADMINISTRATOR' as const],
      mfaEnrolled: false,
    };
    authenticate.mockResolvedValueOnce(staffPrincipal);
    beginMfa.mockResolvedValueOnce({
      status: 'MFA_ENROLLMENT_REQUIRED',
      challengeToken: Buffer.alloc(32, 11).toString('base64url'),
      expiresAt: '2026-09-02T10:05:00.000Z',
      sharedSecret: 'JBSWY3DPEHPK3PXP',
      provisioningUri: 'otpauth://totp/PULSE%2F%2FFIELD:staff',
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .send({ email: 'admin@example.test', password: 'a-safe-example-passphrase' });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: 'MFA_ENROLLMENT_REQUIRED',
      sharedSecret: 'JBSWY3DPEHPK3PXP',
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('completes MFA enrollment without creating a session', async () => {
    const challengeToken = Buffer.alloc(32, 7).toString('base64url');
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa-enrollments')
      .set('origin', 'http://localhost:3000')
      .send({ challengeToken, totpCode: '123456' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      status: 'MFA_ENROLLED',
      recoveryCodes: ['ABCDE-12345-ABCDE-12345'],
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(enrollMfa).toHaveBeenCalledWith(challengeToken, '123456');
    expect(incrementRateLimit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(incrementRateLimit.mock.calls)).not.toContain(challengeToken);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('creates a session only after successful staff MFA authentication', async () => {
    const challengeToken = Buffer.alloc(32, 8).toString('base64url');
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa-authentications')
      .set('origin', 'http://localhost:3000')
      .send({ challengeToken, recoveryCode: 'ABCDE-12345-ABCDE-12345' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(sessionView);
    expect(response.headers.location).toBe('/api/v1/auth/sessions/current');
    expect(response.headers['set-cookie']?.[0]).toContain(`${SESSION_COOKIE_NAME}=${sessionId}`);
    expect(authenticateMfa).toHaveBeenCalledWith(challengeToken, {
      totpCode: undefined,
      recoveryCode: 'ABCDE-12345-ABCDE-12345',
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['FULFILLER'], mfaEnrolled: true }),
      'PASSWORD_MFA',
      undefined,
    );
  });

  it('rejects malformed and cross-site MFA completion before account mutation', async () => {
    const challengeToken = Buffer.alloc(32, 9).toString('base64url');
    const malformed = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa-authentications')
      .send({ challengeToken, totpCode: '12345' });
    expect(malformed.status).toBe(400);
    expect(authenticateMfa).not.toHaveBeenCalled();

    const crossSite = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa-authentications')
      .set('origin', 'http://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .send({ challengeToken, totpCode: '123456' });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).toMatchObject({ code: 'CROSS_SITE_REQUEST_REJECTED' });
    expect(authenticateMfa).not.toHaveBeenCalled();
  });

  it('maps MFA failures to one generic response without echoing credentials', async () => {
    const challengeToken = Buffer.alloc(32, 10).toString('base64url');
    authenticateMfa.mockRejectedValueOnce(new MfaAuthenticationFailedError());

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa-authentications')
      .send({ challengeToken, totpCode: '123456' });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'MFA_AUTHENTICATION_FAILED' });
    expect(JSON.stringify(response.body)).not.toContain(challengeToken);
    expect(JSON.stringify(response.body)).not.toContain('123456');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rotates a staff session after password and MFA reauthentication', async () => {
    const staffSession = {
      ...sessionView,
      user: { ...sessionView.user, roles: ['ADMINISTRATOR' as const] },
    };
    currentSession.mockResolvedValueOnce(staffSession);
    createSession.mockResolvedValueOnce({ sessionId, view: staffSession });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/reauthentications')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .send({ password: 'a-safe-example-passphrase', totpCode: '123456' });

    expect(response.status).toBe(201);
    expect(reauthenticateMfa).toHaveBeenCalledWith(staffSession.user.id, {
      password: 'a-safe-example-passphrase',
      totpCode: '123456',
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['ADMINISTRATOR'], mfaEnrolled: true }),
      'PASSWORD_MFA',
      sessionId,
    );
    expect(response.headers['set-cookie']?.[0]).toContain(`${SESSION_COOKIE_NAME}=${sessionId}`);
  });

  it('rejects staff reauthentication when the CSRF token is missing', async () => {
    currentSession.mockResolvedValueOnce({
      ...sessionView,
      user: { ...sessionView.user, roles: ['FULFILLER' as const] },
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/reauthentications')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .send({ password: 'a-safe-example-passphrase', totpCode: '123456' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'INVALID_CSRF_TOKEN' });
    expect(reauthenticateMfa).not.toHaveBeenCalled();
  });

  it('allows a recently authenticated administrator to grant a staff role', async () => {
    const administratorSession = {
      ...sessionView,
      user: { ...sessionView.user, roles: ['ADMINISTRATOR' as const] },
      authenticatedAt: new Date().toISOString(),
    };
    currentSession.mockResolvedValueOnce(administratorSession);
    const targetId = '1c41ff8c-f6a9-4e8e-af74-2768909e20c4';

    const response = await request(app.getHttpServer())
      .put(`/api/v1/staff/users/${targetId}/roles/FULFILLER`)
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .set('x-request-id', 'request-staff-role-123')
      .send({ reason: 'Approved staffing responsibility change' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: targetId, roles: ['CUSTOMER', 'FULFILLER'] });
    expect(grantStaffRole).toHaveBeenCalledWith(
      targetId,
      'FULFILLER',
      expect.objectContaining({
        requestId: 'request-staff-role-123',
        actor: expect.objectContaining({
          id: administratorSession.user.id,
          roles: ['ADMINISTRATOR'],
        }),
        reason: 'Approved staffing responsibility change',
      }),
    );
  });

  it('rejects staff-role changes from a stale administrator session', async () => {
    currentSession.mockResolvedValueOnce({
      ...sessionView,
      user: { ...sessionView.user, roles: ['ADMINISTRATOR' as const] },
      authenticatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });

    const response = await request(app.getHttpServer())
      .delete('/api/v1/staff/users/1c41ff8c-f6a9-4e8e-af74-2768909e20c4/roles/FULFILLER')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .send({ reason: 'Staffing responsibility ended' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'RECENT_AUTHENTICATION_REQUIRED' });
    expect(revokeStaffRole).not.toHaveBeenCalled();
  });

  it('rejects unsupported role names before staff-role mutation', async () => {
    currentSession.mockResolvedValueOnce({
      ...sessionView,
      user: { ...sessionView.user, roles: ['ADMINISTRATOR' as const] },
      authenticatedAt: new Date().toISOString(),
    });

    const response = await request(app.getHttpServer())
      .put('/api/v1/staff/users/1c41ff8c-f6a9-4e8e-af74-2768909e20c4/roles/CUSTOMER')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .send({ reason: 'Invalid client-selected role' });

    expect(response.status).toBe(400);
    expect(grantStaffRole).not.toHaveBeenCalled();
  });

  it('returns only a masked account view to a recently authenticated administrator', async () => {
    const administratorSession = {
      ...sessionView,
      user: { ...sessionView.user, roles: ['ADMINISTRATOR' as const] },
      authenticatedAt: new Date().toISOString(),
    };
    currentSession.mockResolvedValueOnce(administratorSession);
    const email = 'ayoub.exampleshop@example.com';

    const response = await request(app.getHttpServer())
      .post('/api/v1/staff/user-lookups')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .set('x-request-id', 'request-account-view-123')
      .send({ email, reason: 'Locate account for approved staff assignment' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      userId: '1c41ff8c-f6a9-4e8e-af74-2768909e20c4',
      emailMasked: 'a***@e***.com',
      status: 'ACTIVE',
      verified: true,
      roles: ['CUSTOMER'],
    });
    expect(JSON.stringify(response.body)).not.toContain(email);
    expect(lookupStaffAccount).toHaveBeenCalledWith(
      email,
      expect.objectContaining({
        requestId: 'request-account-view-123',
        actor: expect.objectContaining({ roles: ['ADMINISTRATOR'] }),
        reason: 'Locate account for approved staff assignment',
      }),
    );
  });

  it('does not allow a fulfiller to perform a global account lookup', async () => {
    currentSession.mockResolvedValueOnce({
      ...sessionView,
      user: { ...sessionView.user, roles: ['FULFILLER' as const] },
      authenticatedAt: new Date().toISOString(),
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/staff/user-lookups')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .send({
        email: 'private@example.test',
        reason: 'Attempted global account lookup',
      });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(lookupStaffAccount).not.toHaveBeenCalled();
  });

  it('allows a recently authenticated administrator to replay a terminal notification', async () => {
    const administratorSession = {
      ...sessionView,
      user: { ...sessionView.user, roles: ['ADMINISTRATOR' as const] },
      authenticatedAt: new Date().toISOString(),
    };
    currentSession.mockResolvedValueOnce(administratorSession);
    const deliveryId = '1c41ff8c-f6a9-4e8e-af74-2768909e20c4';

    const response = await request(app.getHttpServer())
      .post(`/api/v1/staff/notification-deliveries/${deliveryId}/replays`)
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .set('x-request-id', 'request-notification-replay-123')
      .send({ reason: 'Retry a terminally failed identity notification' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      deliveryId,
      replayEventId: 'e6a4e676-9e91-4679-80d4-b4d98cacb64c',
    });
    expect(replayNotificationDelivery).toHaveBeenCalledWith(
      deliveryId,
      expect.objectContaining({
        requestId: 'request-notification-replay-123',
        actor: expect.objectContaining({ roles: ['ADMINISTRATOR'] }),
        reason: 'Retry a terminally failed identity notification',
      }),
    );
  });

  it('rejects notification replay from a stale administrator session', async () => {
    currentSession.mockResolvedValueOnce({
      ...sessionView,
      user: { ...sessionView.user, roles: ['ADMINISTRATOR' as const] },
      authenticatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/staff/notification-deliveries/1c41ff8c-f6a9-4e8e-af74-2768909e20c4/replays')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken)
      .send({ reason: 'Attempt replay after stale authentication' });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'RECENT_AUTHENTICATION_REQUIRED' });
    expect(replayNotificationDelivery).not.toHaveBeenCalled();
  });

  it('returns the current session from an opaque cookie', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions/current')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(sessionView);
    expect(currentSession).toHaveBeenCalledWith(sessionId);
  });

  it('requires a valid cookie to inspect the current session', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/auth/sessions/current');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(currentSession).not.toHaveBeenCalled();
  });

  it('returns one safe forbidden response when no declared role matches', async () => {
    currentSession.mockResolvedValueOnce({
      ...sessionView,
      user: { ...sessionView.user, roles: [] },
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions/current')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      detail: 'You are not allowed to perform this action.',
    });
    expect(JSON.stringify(response.body)).not.toContain('CUSTOMER');
    expect(JSON.stringify(response.body)).not.toContain('FULFILLER');
    expect(JSON.stringify(response.body)).not.toContain('ADMINISTRATOR');
  });

  it('logs out with CSRF protection and clears the session cookie', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/v1/auth/sessions/current')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(logout).toHaveBeenCalledWith(sessionId, csrfToken);
    expect(response.headers['set-cookie']?.[0]).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it('does not clear a valid session when its CSRF token is wrong', async () => {
    logout.mockRejectedValueOnce(new InvalidCsrfTokenError());

    const response = await request(app.getHttpServer())
      .delete('/api/v1/auth/sessions/current')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', 'wrong-token');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'INVALID_CSRF_TOKEN' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('logs out every device with authentication and CSRF protection', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/v1/auth/sessions')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(currentSession).toHaveBeenCalledWith(sessionId);
    expect(logoutAll).toHaveBeenCalledWith(sessionId, csrfToken);
    expect(response.headers['set-cookie']?.[0]).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it('requires a current session before logging out every device', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/v1/auth/sessions')
      .set('origin', 'http://localhost:3000')
      .set('x-csrf-token', csrfToken);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(logoutAll).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('does not clear the cookie when logout-all CSRF validation fails', async () => {
    logoutAll.mockRejectedValueOnce(new InvalidCsrfTokenError());

    const response = await request(app.getHttpServer())
      .delete('/api/v1/auth/sessions')
      .set('origin', 'http://localhost:3000')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', 'wrong-token');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'INVALID_CSRF_TOKEN' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects cross-site logout-all requests before session mutation', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/v1/auth/sessions')
      .set('origin', 'http://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .set('cookie', `${SESSION_COOKIE_NAME}=${sessionId}`)
      .set('x-csrf-token', csrfToken);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'CROSS_SITE_REQUEST_REJECTED' });
    expect(currentSession).not.toHaveBeenCalled();
    expect(logoutAll).not.toHaveBeenCalled();
  });

  it('exposes a standard Retry-After header when either login bucket blocks', async () => {
    incrementRateLimit
      .mockResolvedValueOnce({
        totalHits: 1,
        timeToExpire: 700,
        isBlocked: false,
        timeToBlockExpire: 0,
      })
      .mockResolvedValueOnce({
        totalHits: 6,
        timeToExpire: 700,
        isBlocked: true,
        timeToBlockExpire: 900,
      });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .send({ email: 'customer@example.test', password: 'a-safe-example-passphrase' });

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('900');
    expect(response.body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('allows credentialed session mutation headers in CORS preflight', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/auth/sessions/current')
      .set('origin', 'http://localhost:3000')
      .set('access-control-request-method', 'DELETE')
      .set('access-control-request-headers', 'x-csrf-token');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
    expect(response.headers['access-control-allow-headers'].toLowerCase()).toContain(
      'x-csrf-token',
    );
  });

  it('publishes both identity request schemas in OpenAPI', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.paths).toHaveProperty('/api/v1/auth/registrations.post');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/email-verifications.post');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/email-verification-requests.post');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/password-recovery-requests.post');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/password-resets.post');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/sessions.post');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/sessions.delete');
    expect(response.body.paths['/api/v1/auth/sessions'].delete.security).toEqual([
      { 'session-cookie': [] },
    ]);
    expect(response.body.paths).toHaveProperty('/api/v1/auth/sessions/current.get');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/sessions/current.delete');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/mfa-enrollments.post');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/mfa-authentications.post');
    expect(response.body.paths).toHaveProperty('/api/v1/auth/reauthentications.post');
    expect(response.body.paths).toHaveProperty('/api/v1/staff/users/{userId}/roles/{role}.put');
    expect(response.body.paths).toHaveProperty('/api/v1/staff/users/{userId}/roles/{role}.delete');
    expect(response.body.paths).toHaveProperty('/api/v1/staff/user-lookups.post');
    expect(response.body.paths).toHaveProperty(
      '/api/v1/staff/notification-deliveries/{deliveryId}/replays.post',
    );
    expect(response.body.components.securitySchemes['session-cookie']).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: SESSION_COOKIE_NAME,
    });
    expect(response.body.components.schemas.SessionDto.properties.csrfToken).toMatchObject({
      readOnly: true,
    });
    expect(response.body.components.schemas.RegisterCustomerDto.properties.password).toMatchObject({
      writeOnly: true,
      minLength: 15,
      maxLength: 128,
    });
    expect(response.body.components.schemas.ResetPasswordDto.properties.newPassword).toMatchObject({
      writeOnly: true,
      minLength: 15,
      maxLength: 128,
    });
    expect(
      response.body.components.schemas.CompleteMfaAuthenticationDto.properties.challengeToken,
    ).toMatchObject({ writeOnly: true });
    expect(
      response.body.components.schemas.CompleteMfaAuthenticationDto.properties.totpCode,
    ).toMatchObject({ writeOnly: true });
  });
});
