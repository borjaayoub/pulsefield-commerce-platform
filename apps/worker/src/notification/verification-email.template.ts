import type { NotificationMessage } from '@pulse-field/contracts';

export const EMAIL_VERIFICATION_TEMPLATE = 'identity.email-verification.v1';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  messageId: string;
}

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

export function renderVerificationEmail(message: NotificationMessage): RenderedEmail {
  if (message.template !== EMAIL_VERIFICATION_TEMPLATE || message.locale !== 'en') {
    throw new Error('Notification template is unsupported.');
  }

  const verificationUrl = requiredString(message.data, 'verificationUrl');
  const expiresAt = requiredString(message.data, 'expiresAt');
  const sourceEventId = requiredString(message.data, 'sourceEventId');
  const safeUrl = escapeHtml(verificationUrl);
  const safeExpiry = escapeHtml(expiresAt);

  return {
    subject: 'Verify your PULSE//FIELD account',
    text: [
      'Welcome to PULSE//FIELD.',
      '',
      `Verify your account: ${verificationUrl}`,
      `This local verification link expires at ${expiresAt}.`,
      '',
      'If you did not create this account, ignore this message.',
    ].join('\n'),
    html: [
      '<h1>Verify your PULSE//FIELD account</h1>',
      '<p>Welcome to PULSE//FIELD.</p>',
      `<p><a href="${safeUrl}">Verify your account</a></p>`,
      `<p>This local verification link expires at ${safeExpiry}.</p>`,
      '<p>If you did not create this account, ignore this message.</p>',
    ].join(''),
    messageId: `<verification-${sourceEventId}@pulsefield.local>`,
  };
}
