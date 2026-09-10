import type { NotificationMessage } from '@pulse-field/contracts';
import {
  PASSWORD_RECOVERY_TEMPLATE,
  renderPasswordRecoveryEmail,
} from './password-recovery.template';

describe('password recovery email template', () => {
  const message: NotificationMessage = {
    recipient: 'customer@example.test',
    template: PASSWORD_RECOVERY_TEMPLATE,
    locale: 'en',
    data: {
      passwordResetUrl: 'http://localhost:3000/reset-password?token=a&next=<unsafe>',
      expiresAt: '2026-09-02T20:00:00.000Z',
      sourceEventId: 'f62d69e7-0c86-4df8-b592-577815cb8461',
    },
  };

  it('renders text, escaped HTML, and a stable local message ID', () => {
    const rendered = renderPasswordRecoveryEmail(message);
    expect(rendered.text).toContain('token=a&next=<unsafe>');
    expect(rendered.html).toContain('token=a&amp;next=&lt;unsafe&gt;');
    expect(rendered.html).not.toContain('next=<unsafe>');
    expect(rendered.messageId).toBe(
      '<password-recovery-f62d69e7-0c86-4df8-b592-577815cb8461@pulsefield.local>',
    );
  });

  it('rejects unknown template versions', () => {
    expect(() => renderPasswordRecoveryEmail({ ...message, template: 'unknown' })).toThrow(
      'unsupported',
    );
  });
});
