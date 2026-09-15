import {
  ORDER_CONFIRMATION_TEMPLATE,
  renderOrderConfirmationEmail,
} from './order-confirmation.template';

describe('order confirmation template', () => {
  it('renders escaped order evidence with a stable message id', () => {
    const rendered = renderOrderConfirmationEmail({
      recipient: 'buyer@example.test',
      template: ORDER_CONFIRMATION_TEMPLATE,
      locale: 'en',
      data: {
        orderReference: 'PF-ABCDEF123456',
        orderTimelineUrl: 'http://localhost:3000/orders/PF-ABCDEF123456#access=safe-token',
        accessExpiresAt: '2026-10-01T20:00:00.000Z',
        sourceEventId: 'event-1',
      },
    });
    expect(rendered.subject).toContain('PF-ABCDEF123456');
    expect(rendered.messageId).toBe('<order-confirmation-event-1@pulsefield.local>');
  });
});
