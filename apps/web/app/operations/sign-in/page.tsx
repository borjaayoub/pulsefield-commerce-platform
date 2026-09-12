'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';
type Challenge = {
  status: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  challengeToken: string;
  expiresAt: string;
  sharedSecret?: string;
  provisioningUri?: string;
};

export default function OperationsSignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`${API_ORIGIN}/api/v1/auth/sessions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = (await response.json()) as Challenge | { user?: unknown };
      if (!response.ok) throw new Error('Sign-in failed. Check your credentials.');
      if (
        'status' in body &&
        (body.status === 'MFA_REQUIRED' || body.status === 'MFA_ENROLLMENT_REQUIRED')
      )
        setChallenge(body);
      else window.location.assign('/operations');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function completeMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setMessage('');
    try {
      const endpoint =
        challenge.status === 'MFA_ENROLLMENT_REQUIRED' ? 'mfa-enrollments' : 'mfa-authentications';
      const response = await fetch(`${API_ORIGIN}/api/v1/auth/${endpoint}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: challenge.challengeToken, totpCode: code }),
      });
      if (!response.ok) throw new Error('The verification code was rejected.');
      if (challenge.status === 'MFA_ENROLLMENT_REQUIRED') {
        const enrolled = (await response.json()) as { recoveryCodes?: string[] };
        setRecoveryCodes(enrolled.recoveryCodes ?? []);
        const login = await fetch(`${API_ORIGIN}/api/v1/auth/sessions`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const next = (await login.json()) as Challenge;
        if (!login.ok || next.status !== 'MFA_REQUIRED')
          throw new Error('Enrollment succeeded, but a fresh MFA challenge could not be created.');
        setChallenge(next);
        setCode('');
      } else window.location.assign('/operations');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Verification failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="operations-shell">
      <nav className="catalog-nav">
        <Link href="/" className="wordmark">
          PULSE//FIELD
        </Link>
        <Link href="/catalog" className="text-link">
          Storefront
        </Link>
      </nav>
      <section className="operations-auth panel" aria-labelledby="operations-sign-in-heading">
        <p className="eyebrow">Restricted staff area</p>
        <h1 id="operations-sign-in-heading">Operations sign-in</h1>
        {!challenge ? (
          <form onSubmit={submit} className="operations-form">
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button disabled={!hydrated || busy}>{busy ? 'Signing in…' : 'Continue'}</button>
          </form>
        ) : (
          <form onSubmit={completeMfa} className="operations-form">
            <h2>
              {challenge.status === 'MFA_ENROLLMENT_REQUIRED'
                ? 'Set up authenticator'
                : 'Verify authenticator'}
            </h2>
            {recoveryCodes ? (
              <p className="detail-note">
                Save these one-time recovery codes somewhere safe; they will not be shown again:{' '}
                <code>{recoveryCodes.join(' ')}</code>
              </p>
            ) : null}
            {challenge.provisioningUri ? (
              <p className="detail-note">
                Scan the one-time provisioning URI with your authenticator, then enter the generated
                code.
              </p>
            ) : null}
            {challenge.sharedSecret ? (
              <p>
                <strong>One-time secret:</strong> <code>{challenge.sharedSecret}</code>
              </p>
            ) : null}
            <label>
              Authenticator code
              <input
                inputMode="numeric"
                pattern="[0-9]{6}"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                required
              />
            </label>
            <button disabled={!hydrated || busy}>
              {busy ? 'Verifying…' : 'Verify and continue'}
            </button>
          </form>
        )}
        {message ? (
          <p role="alert" className="cart-message">
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
