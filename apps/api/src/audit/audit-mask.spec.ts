import { maskAuditIdentifier, maskAuditMetadata, redactAuditText } from './audit-mask';

describe('audit presentation masking', () => {
  it('masks direct identifiers while retaining a short investigation suffix', () => {
    expect(maskAuditIdentifier('customer-123456')).toBe('***3456');
    expect(maskAuditIdentifier('abc')).toBe('***abc');
  });

  it('redacts email, credential, and long-number values defensively', () => {
    expect(
      redactAuditText(
        'Contact person@example.test or +212 612 345 678 using Bearer raw-token or 4111111111111111.',
      ),
    ).toBe(
      'Contact [REDACTED_EMAIL] or [REDACTED_PHONE] using [REDACTED_CREDENTIAL] or [REDACTED_NUMBER].',
    );
  });

  it('redacts suspicious metadata keys recursively', () => {
    expect(
      maskAuditMetadata({
        version: 3,
        nested: { customerEmail: 'person@example.test', status: 'ACTIVE' },
      }),
    ).toEqual({
      version: 3,
      nested: { customerEmail: '[REDACTED]', status: 'ACTIVE' },
    });
  });
});
