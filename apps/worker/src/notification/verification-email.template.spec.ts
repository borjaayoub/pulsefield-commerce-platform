import type { NotificationMessage } from '@pulse-field/contracts';
import {
  EMAIL_VERIFICATION_TEMPLATE,
  renderVerificationEmail,
} from './verification-email.template';

describe('verification email template', () => {
  const message: NotificationMessage = {
    recipient: 'customer@example.test',
    template: EMAIL_VERIFICATION_TEMPLATE,
    locale: 'en',
    data: {
      verificationUrl: 'http://localhost:3000/verify-email?token=a&next=<unsafe>',
      expiresAt: '2026-09-02T04:00:00.000Z',
      sourceEventId: 'f62d69e7-0c86-4df8-b592-577815cb8461',
    },
  };

  it('renders text, escaped HTML, and a stable local message ID', () => {
    const rendered = renderVerificationEmail(message);

    expect(rendered.text).toContain('token=a&next=<unsafe>');
    expect(rendered.html).toContain('token=a&amp;next=&lt;unsafe&gt;');
    expect(rendered.html).not.toContain('next=<unsafe>');
    expect(rendered.messageId).toBe(
      '<verification-f62d69e7-0c86-4df8-b592-577815cb8461@pulsefield.local>',
    );
  });

  it('rejects unknown template versions', () => {
    expect(() => renderVerificationEmail({ ...message, template: 'unknown' })).toThrow(
      'unsupported',
    );
  });
});
