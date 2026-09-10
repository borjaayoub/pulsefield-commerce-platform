import type { NotificationMessage } from '@pulse-field/contracts';
import type { RenderedEmail } from './verification-email.template';

export const PASSWORD_RECOVERY_TEMPLATE = 'identity.password-recovery.v1';

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Notification template data is invalid.');
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderPasswordRecoveryEmail(message: NotificationMessage): RenderedEmail {
  if (message.template !== PASSWORD_RECOVERY_TEMPLATE || message.locale !== 'en') {
    throw new Error('Notification template is unsupported.');
  }

  const passwordResetUrl = requiredString(message.data, 'passwordResetUrl');
  const expiresAt = requiredString(message.data, 'expiresAt');
  const sourceEventId = requiredString(message.data, 'sourceEventId');

  return {
    subject: 'Reset your PULSE//FIELD password',
    text: [
      'A password reset was requested for your PULSE//FIELD account.',
      '',
      `Reset your password: ${passwordResetUrl}`,
      `This local recovery link expires at ${expiresAt}.`,
      '',
      'If you did not request this change, ignore this message.',
    ].join('\n'),
    html: [
      '<h1>Reset your PULSE//FIELD password</h1>',
      '<p>A password reset was requested for your account.</p>',
      `<p><a href="${escapeHtml(passwordResetUrl)}">Reset your password</a></p>`,
      `<p>This local recovery link expires at ${escapeHtml(expiresAt)}.</p>`,
      '<p>If you did not request this change, ignore this message.</p>',
    ].join(''),
    messageId: `<password-recovery-${sourceEventId}@pulsefield.local>`,
  };
}
