import type { NotificationMessage } from '@pulse-field/contracts';
import type { LocalProfile } from '@pulse-field/foundation';
import type { Transporter } from 'nodemailer';
import { MailpitNotificationAdapter, resolveMailpitSmtpHost } from './mailpit-notification.adapter';
import { EMAIL_VERIFICATION_TEMPLATE } from './verification-email.template';
import { PASSWORD_RECOVERY_TEMPLATE } from './password-recovery.template';

describe('MailpitNotificationAdapter', () => {
  const profile = { SMTP_ALLOW_EXTERNAL: false, SMTP_HOST: 'localhost' } as LocalProfile;
  const message: NotificationMessage = {
    recipient: 'customer@example.test',
    template: EMAIL_VERIFICATION_TEMPLATE,
    locale: 'en',
    data: {
      verificationUrl: 'http://localhost:3000/verify-email?token=safe-token',
      expiresAt: '2026-09-02T04:00:00.000Z',
      sourceEventId: 'f62d69e7-0c86-4df8-b592-577815cb8461',
    },
  };

  function createSubject() {
    const sendMail = jest.fn().mockResolvedValue({ messageId: '<provider-id>', rejected: [] });
    const verify = jest.fn().mockResolvedValue(true);
    const close = jest.fn();
    const transporter = { sendMail, verify, close } as unknown as Transporter;
    return {
      adapter: new MailpitNotificationAdapter(profile, transporter),
      sendMail,
      verify,
      close,
    };
  }

  it('sends a rendered local message and returns the provider message ID', async () => {
    const { adapter, sendMail } = createSubject();

    await expect(adapter.send(message)).resolves.toEqual({
      providerMessageId: '<provider-id>',
      status: 'accepted',
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'PULSE//FIELD <no-reply@pulsefield.local>',
        to: 'customer@example.test',
        subject: 'Verify your PULSE//FIELD account',
        messageId: '<verification-f62d69e7-0c86-4df8-b592-577815cb8461@pulsefield.local>',
      }),
    );
  });

  it('treats an SMTP rejection as a retryable failure', async () => {
    const { adapter, sendMail } = createSubject();
    sendMail.mockResolvedValueOnce({
      messageId: '<provider-id>',
      rejected: ['customer@example.test'],
    });

    await expect(adapter.send(message)).rejects.toThrow('Local SMTP rejected');
  });

  it('renders the password-recovery template through the same local transport', async () => {
    const { adapter, sendMail } = createSubject();
    await adapter.send({
      recipient: 'customer@example.test',
      template: PASSWORD_RECOVERY_TEMPLATE,
      locale: 'en',
      data: {
        passwordResetUrl: 'http://localhost:3000/reset-password?token=safe-token',
        expiresAt: '2026-09-02T20:00:00.000Z',
        sourceEventId: 'f62d69e7-0c86-4df8-b592-577815cb8461',
      },
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Reset your PULSE//FIELD password',
        messageId: '<password-recovery-f62d69e7-0c86-4df8-b592-577815cb8461@pulsefield.local>',
      }),
    );
  });

  it('verifies and closes its reusable transport', async () => {
    const { adapter, verify, close } = createSubject();

    await expect(adapter.verify()).resolves.toBe(true);
    adapter.close();

    expect(verify).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('refuses profiles that allow external SMTP', () => {
    expect(
      () =>
        new MailpitNotificationAdapter(
          { SMTP_ALLOW_EXTERNAL: true, SMTP_HOST: 'localhost' } as LocalProfile,
          {} as Transporter,
        ),
    ).toThrow('only the local Mailpit');
  });

  it('refuses a remote SMTP host even when external delivery is flagged off', () => {
    expect(
      () =>
        new MailpitNotificationAdapter(
          { SMTP_ALLOW_EXTERNAL: false, SMTP_HOST: 'smtp.example.test' } as LocalProfile,
          {} as Transporter,
        ),
    ).toThrow('only the local Mailpit');
  });

  it('uses IPv4 loopback for host-process localhost SMTP', () => {
    expect(resolveMailpitSmtpHost('localhost')).toBe('127.0.0.1');
    expect(resolveMailpitSmtpHost('mailpit')).toBe('mailpit');
  });
});
