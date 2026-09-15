-- Preserve the existing attach-once provider identity behavior and permit the
-- recovered order projection to convert its reopened cart exactly once.

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
       AND NEW."providerReference" = NEW."providerPaymentId"
       AND NEW."failureCode" IS NOT DISTINCT FROM OLD."failureCode" THEN
      RETURN NEW;
    END IF;
    IF NEW."failureCode" IS DISTINCT FROM OLD."failureCode"
       OR NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
       OR NEW."providerReference" IS DISTINCT FROM OLD."providerReference" THEN
      RAISE EXCEPTION 'payment evidence requires a lifecycle transition';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD."status" = 'REQUIRES_PAYMENT_METHOD'
       AND NEW."status" IN ('PROCESSING', 'SUCCEEDED', 'FAILED'))
     OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED'))
     OR (OLD."status" = 'FAILED'
       AND OLD."failureCode" = 'RESERVATION_EXPIRED'
       AND NEW."status" = 'SUCCEEDED'
       AND NEW."failureCode" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid payment attempt status transition';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "enforce_cart_state_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'OPEN' AND NEW."status" = 'CHECKOUT_PENDING')
      OR (OLD."status" = 'CHECKOUT_PENDING' AND NEW."status" IN ('OPEN', 'CONVERTED'))
      OR (
        OLD."status" = 'OPEN' AND NEW."status" = 'CONVERTED'
        AND EXISTS (
          SELECT 1 FROM "Order" AS purchase
          JOIN "InventoryReservation" AS original
            ON original."id" = purchase."reservationId"
          JOIN "InventoryReservation" AS recovery
            ON recovery."id" = purchase."recoveryReservationId"
          WHERE purchase."cartId" = NEW."id"
            AND purchase."status" = 'CONFIRMED'
            AND original."status" = 'EXPIRED'
            AND recovery."status" = 'COMMITTED'
        )
      )
    ) THEN
      RAISE EXCEPTION 'invalid cart status transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
