import { buildContentSecurityPolicy, createCspNonce, safeApiOrigin } from './csp';

describe('web CSP', () => {
  it('creates unique base64 nonces', () => {
    const first = createCspNonce();
    const second = createCspNonce();
    expect(first).toMatch(/^[A-Za-z0-9+/]{22}==$/u);
    expect(second).toMatch(/^[A-Za-z0-9+/]{22}==$/u);
    expect(second).not.toBe(first);
  });

  it('keeps the production script policy nonce-based without unsafe-inline', () => {
    const policy = buildContentSecurityPolicy('nonce-test', false);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("font-src 'self'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain(
      "script-src 'self' 'nonce-nonce-test' https://js.stripe.com https://*.js.stripe.com",
    );
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("connect-src 'self' http://localhost:4000 https://api.stripe.com");
    expect(policy).toContain(
      'frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com',
    );
    expect(policy).not.toContain('maps.googleapis.com');
    expect(policy).not.toContain('link.com');
    expect(policy).not.toContain('checkout.stripe.com');
    expect(policy).toContain("form-action 'self'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('allows only the documented development eval allowance', () => {
    expect(buildContentSecurityPolicy('nonce-dev', true)).toContain("'unsafe-eval'");
  });

  it('reduces a configured API URL to a safe HTTP(S) origin', () => {
    expect(safeApiOrigin('https://api.example.test/v1?mode=local')).toBe(
      'https://api.example.test',
    );
    expect(buildContentSecurityPolicy('nonce-api', false, 'https://api.example.test/v1')).toContain(
      "connect-src 'self' https://api.example.test",
    );
  });

  it('falls back safely for invalid, credentialed, or non-HTTP API values', () => {
    for (const value of [
      'not a URL',
      'https://user:password@api.example.test',
      'javascript:alert(1)',
      'https://api.example.test; script-src *',
    ]) {
      expect(safeApiOrigin(value)).toBe('http://localhost:4000');
      expect(buildContentSecurityPolicy('nonce-safe', false, value)).toContain(
        "connect-src 'self' http://localhost:4000 https://api.stripe.com",
      );
      expect(buildContentSecurityPolicy('nonce-safe', false, value)).not.toContain(value);
    }
  });
});
