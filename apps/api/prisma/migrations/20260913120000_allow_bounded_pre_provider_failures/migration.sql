-- Allow only the two approved Stripe failure outcomes to be persisted before
-- a provider PaymentIntent identity has been attached. Terminal success and
-- every other terminal failure still require an immutable provider identity.

ALTER TABLE "PaymentAttempt"
  DROP CONSTRAINT IF EXISTS "PaymentAttempt_provider_identity_check";

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_provider_identity_check" CHECK (
    "status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')
    OR (
      "status" IN ('SUCCEEDED', 'FAILED')
      AND "providerPaymentId" IS NOT NULL
    )
    OR (
      "provider" = 'stripe'
      AND "status" = 'FAILED'
      AND "providerPaymentId" IS NULL
      AND "providerReference" IS NULL
      AND "failureCode" IN ('PAYMENT_PROVIDER_REJECTED', 'RESERVATION_EXPIRED')
    )
  );
