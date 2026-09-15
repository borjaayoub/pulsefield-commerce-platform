-- A provider call occurs after the internal attempt is committed. Permit that
-- requires-payment-method attempt to attach its provider identity exactly once.
-- Later changes remain rejected by the immutable provider identity guard.

CREATE OR REPLACE FUNCTION "enforce_payment_attempt_transition"()
RETURNS trigger AS $$
BEGIN
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."paymentMethodReference" IS DISTINCT FROM OLD."paymentMethodReference"
     OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'payment attempt identity and money snapshot are immutable';
  END IF;

  IF OLD."providerPaymentId" IS NOT NULL
     AND NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId" THEN
    RAISE EXCEPTION 'provider payment identity is immutable once accepted';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF OLD."status" = 'REQUIRES_PAYMENT_METHOD'
       AND OLD."providerPaymentId" IS NULL
       AND NEW."providerPaymentId" IS NOT NULL
       AND NEW."failureCode" IS NOT DISTINCT FROM OLD."failureCode" THEN
      RETURN NEW;
    END IF;
    IF NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
       OR NEW."providerReference" IS DISTINCT FROM OLD."providerReference"
       OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode" THEN
      RAISE EXCEPTION 'payment attempt evidence requires a lifecycle transition';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD."status" = 'REQUIRES_PAYMENT_METHOD' AND NEW."status" IN ('PROCESSING', 'FAILED'))
     OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED')) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid payment attempt status transition';
END;
$$ LANGUAGE plpgsql;
