import type { NotificationMessage } from '@pulse-field/contracts';
import type { RenderedEmail } from './verification-email.template';

export const ORDER_CONFIRMATION_TEMPLATE = 'commerce.order-confirmation.v1';

function required(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('Notification template data is invalid.');
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

export function renderOrderConfirmationEmail(message: NotificationMessage): RenderedEmail {
  if (message.template !== ORDER_CONFIRMATION_TEMPLATE || message.locale !== 'en')
    throw new Error('Notification template is unsupported.');
  const orderReference = required(message.data, 'orderReference');
  const orderTimelineUrl = required(message.data, 'orderTimelineUrl');
  const accessExpiresAt = required(message.data, 'accessExpiresAt');
  const sourceEventId = required(message.data, 'sourceEventId');
  return {
    subject: `PULSE//FIELD order ${orderReference} confirmed`,
    text: [
      `Order ${orderReference} is confirmed.`,
      '',
      `View order status: ${orderTimelineUrl}`,
      `This local order link expires at ${accessExpiresAt}.`,
    ].join('\n'),
    html: [
      `<h1>Order ${escapeHtml(orderReference)} confirmed</h1>`,
      `<p><a href="${escapeHtml(orderTimelineUrl)}">View order status</a></p>`,
      `<p>This local order link expires at ${escapeHtml(accessExpiresAt)}.</p>`,
    ].join(''),
    messageId: `<order-confirmation-${sourceEventId}@pulsefield.local>`,
  };
}
