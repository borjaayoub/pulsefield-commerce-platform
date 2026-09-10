import type {
  DeliveryResult,
  NotificationMessage,
  NotificationProvider,
} from '@pulse-field/contracts';
import type { LocalProfile } from '@pulse-field/foundation';
import nodemailer, { type Transporter } from 'nodemailer';
import { renderVerificationEmail } from './verification-email.template';
import {
  PASSWORD_RECOVERY_TEMPLATE,
  renderPasswordRecoveryEmail,
} from './password-recovery.template';

export function resolveMailpitSmtpHost(host: string): string {
  return host === 'localhost' ? '127.0.0.1' : host;
}

export class MailpitNotificationAdapter implements NotificationProvider {
  private readonly transporter: Transporter;

  constructor(profile: LocalProfile, transporter?: Transporter) {
    if (
      profile.SMTP_ALLOW_EXTERNAL ||
      !new Set(['localhost', '127.0.0.1', 'mailpit']).has(profile.SMTP_HOST)
    ) {
      throw new Error('The Mailpit adapter can target only the local Mailpit SMTP service.');
    }
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        pool: true,
        host: resolveMailpitSmtpHost(profile.SMTP_HOST),
        port: profile.SMTP_PORT,
        secure: false,
        auth: undefined,
      });
  }

  async verify(): Promise<boolean> {
    return this.transporter.verify();
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    const rendered =
      message.template === PASSWORD_RECOVERY_TEMPLATE
        ? renderPasswordRecoveryEmail(message)
        : renderVerificationEmail(message);
    const result = await this.transporter.sendMail({
      from: 'PULSE//FIELD <no-reply@pulsefield.local>',
      to: message.recipient,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      messageId: rendered.messageId,
    });

    if (Array.isArray(result.rejected) && result.rejected.length > 0) {
      throw new Error('Local SMTP rejected the notification.');
    }

    return { providerMessageId: String(result.messageId), status: 'accepted' };
  }

  close(): void {
    this.transporter.close();
  }
}
