'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { FormEvent, useMemo, useState } from 'react';
import { safePaymentErrorMessage, stripeReturnUrl } from './checkout-payment';

type StripePaymentStepProps = {
  publishableKey: string;
  clientSecret: string;
  orderReference: string;
  guestOrderAccessToken: string;
  onSubmitted: () => void;
};

const appearance = {
  theme: 'stripe' as const,
  variables: {
    colorPrimary: '#161616',
    colorText: '#161616',
    colorDanger: '#9f2d20',
    borderRadius: '4px',
    fontFamily: 'Arial, Helvetica, sans-serif',
  },
};

function StripeConfirmationForm({
  onSubmitted,
  orderReference,
  guestOrderAccessToken,
}: Pick<StripePaymentStepProps, 'onSubmitted' | 'orderReference' | 'guestOrderAccessToken'>) {
  const stripe = useStripe();
  const elements = useElements();
  const [complete, setComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements || !complete || submitting) return;
    setSubmitting(true);
    setMessage('');
    try {
      sessionStorage.setItem(`pulse-field:guest-order:${orderReference}`, guestOrderAccessToken);
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: stripeReturnUrl(window.location.origin, orderReference),
        },
        redirect: 'if_required',
      });
      if (!error) {
        sessionStorage.removeItem(`pulse-field:guest-order:${orderReference}`);
        onSubmitted();
        return;
      }
      setMessage(safePaymentErrorMessage(error.message));
      sessionStorage.removeItem(`pulse-field:guest-order:${orderReference}`);
    } catch {
      sessionStorage.removeItem(`pulse-field:guest-order:${orderReference}`);
      setMessage('Secure payment is temporarily unavailable. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="stripe-payment-form" onSubmit={(event) => void confirm(event)}>
      <PaymentElement
        options={{ layout: 'tabs' }}
        onChange={(event) => setComplete(event.complete)}
        onLoadError={(event) => setMessage(safePaymentErrorMessage(event.error.message))}
      />
      {message ? (
        <p className="cart-message state-error" role="alert">
          {message}
        </p>
      ) : null}
      <button type="submit" disabled={!stripe || !elements || !complete || submitting}>
        {submitting ? 'Confirming securely…' : 'Confirm test payment'}
      </button>
      <p className="detail-note" aria-live="polite">
        {submitting
          ? 'Complete any Stripe test authentication shown in the secure payment frame.'
          : 'Payment details go directly to Stripe. PULSE//FIELD does not receive card data.'}
      </p>
    </form>
  );
}

export default function StripePaymentStep({
  publishableKey,
  clientSecret,
  orderReference,
  guestOrderAccessToken,
  onSubmitted,
}: StripePaymentStepProps) {
  const stripe = useMemo(() => loadStripe(publishableKey), [publishableKey]);
  return (
    <section className="stripe-payment-step" aria-labelledby="payment-heading">
      <p className="eyebrow">Order {orderReference}</p>
      <h1 id="payment-heading">Secure test payment.</h1>
      <p>
        Your order is reserved while Stripe collects payment details. Confirmation follows only
        after the server verifies provider evidence.
      </p>
      <Elements stripe={stripe} options={{ clientSecret, appearance, loader: 'auto' }}>
        <StripeConfirmationForm
          onSubmitted={onSubmitted}
          orderReference={orderReference}
          guestOrderAccessToken={guestOrderAccessToken}
        />
      </Elements>
    </section>
  );
}
