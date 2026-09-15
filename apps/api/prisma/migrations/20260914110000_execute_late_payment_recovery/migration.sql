-- Phase 4 Slice 4.4b: preserve the expired checkout reservation while attaching
-- at most one separately committed late-payment recovery reservation.

ALTER TABLE "Order" ADD COLUMN "recoveryReservationId" UUID;

CREATE UNIQUE INDEX "Order_recoveryReservationId_key"
  ON "Order"("recoveryReservationId");

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_recoveryReservationId_fkey"
  FOREIGN KEY ("recoveryReservationId") REFERENCES "InventoryReservation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "enforce_order_state_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (
       OLD."status" = 'PENDING_PAYMENT'
       AND NEW."status" IN ('CONFIRMED', 'MANUAL_RESOLUTION')
     ) THEN
    RAISE EXCEPTION 'invalid order status transition';
  END IF;
  IF NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."cartId" IS DISTINCT FROM OLD."cartId"
     OR NEW."policyVersionId" IS DISTINCT FROM OLD."policyVersionId"
     OR NEW."priceBookVersionId" IS DISTINCT FROM OLD."priceBookVersionId"
     OR NEW."reservationId" IS DISTINCT FROM OLD."reservationId"
     OR (
       NEW."recoveryReservationId" IS DISTINCT FROM OLD."recoveryReservationId"
       AND NOT (
         OLD."recoveryReservationId" IS NULL
         AND NEW."recoveryReservationId" IS NOT NULL
         AND OLD."status" = 'PENDING_PAYMENT'
         AND NEW."status" = 'CONFIRMED'
       )
     )
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."subtotalMinor" IS DISTINCT FROM OLD."subtotalMinor"
     OR NEW."shippingMinor" IS DISTINCT FROM OLD."shippingMinor"
     OR NEW."taxMinor" IS DISTINCT FROM OLD."taxMinor"
     OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor"
     OR NEW."calculationSnapshot" IS DISTINCT FROM OLD."calculationSnapshot"
     OR NEW."shippingAddressSnapshot" IS DISTINCT FROM OLD."shippingAddressSnapshot" THEN
    RAISE EXCEPTION 'order history is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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

CREATE OR REPLACE FUNCTION "check_checkout_state_consistency"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PaymentAttempt" AS payment
    JOIN "Order" AS purchase ON purchase."id" = payment."orderId"
    WHERE payment."amountMinor" IS DISTINCT FROM purchase."totalMinor"
       OR payment."currencyCode" IS DISTINCT FROM purchase."currencyCode"
  ) THEN
    RAISE EXCEPTION 'payment attempt money does not match immutable order total';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    WHERE purchase."status" = 'PENDING_PAYMENT'
      AND (purchase."recoveryReservationId" IS NOT NULL OR NOT (
        (
          reservation."status" = 'ACTIVE'
          AND cart_record."status" = 'CHECKOUT_PENDING'
          AND NOT EXISTS (SELECT 1 FROM "FulfillmentGroup" WHERE "orderId" = purchase."id")
          AND (SELECT COUNT(*) FROM "PaymentAttempt" WHERE "orderId" = purchase."id"
            AND "status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')) = 1
          AND NOT EXISTS (SELECT 1 FROM "PaymentAttempt" WHERE "orderId" = purchase."id"
            AND "status" = 'SUCCEEDED')
        )
        OR (
          reservation."status" IN ('RELEASED', 'EXPIRED')
          AND cart_record."status" = 'OPEN'
          AND NOT EXISTS (SELECT 1 FROM "FulfillmentGroup" WHERE "orderId" = purchase."id")
          AND NOT EXISTS (SELECT 1 FROM "PaymentAttempt" WHERE "orderId" = purchase."id"
            AND "status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING', 'SUCCEEDED'))
          AND EXISTS (
            SELECT 1 FROM "PaymentAttempt" AS payment
            WHERE payment."orderId" = purchase."id" AND payment."status" = 'FAILED'
              AND ((reservation."status" = 'RELEASED' AND payment."failureCode" <> 'RESERVATION_EXPIRED')
                OR (reservation."status" = 'EXPIRED' AND payment."failureCode" = 'RESERVATION_EXPIRED'))
          )
        )
      ))
  ) THEN
    RAISE EXCEPTION 'pending order has inconsistent active or terminal-failure checkout state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    LEFT JOIN "InventoryReservation" AS recovery ON recovery."id" = purchase."recoveryReservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    WHERE purchase."status" = 'CONFIRMED'
      AND NOT (
        ((purchase."recoveryReservationId" IS NULL AND reservation."status" = 'COMMITTED')
          OR (purchase."recoveryReservationId" IS NOT NULL
            AND reservation."status" = 'EXPIRED' AND recovery."status" = 'COMMITTED'))
        AND cart_record."status" = 'CONVERTED'
        AND NOT EXISTS (SELECT 1 FROM "CartItem" WHERE "cartId" = cart_record."id")
        AND (SELECT COUNT(*) FROM "PaymentAttempt" WHERE "orderId" = purchase."id"
          AND "status" = 'SUCCEEDED') = 1
        AND NOT EXISTS (SELECT 1 FROM "PaymentAttempt" WHERE "orderId" = purchase."id"
          AND "status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING'))
        AND EXISTS (SELECT 1 FROM "FulfillmentGroup" WHERE "orderId" = purchase."id")
      )
  ) THEN
    RAISE EXCEPTION 'confirmed order requires exactly one successful payment and committed allocation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    WHERE purchase."status" = 'MANUAL_RESOLUTION'
      AND NOT (
        purchase."recoveryReservationId" IS NULL
        AND reservation."status" = 'EXPIRED'
        AND cart_record."status" = 'OPEN'
        AND (SELECT COUNT(*) FROM "PaymentAttempt" WHERE "orderId" = purchase."id"
          AND "status" = 'SUCCEEDED') = 1
        AND NOT EXISTS (SELECT 1 FROM "PaymentAttempt" WHERE "orderId" = purchase."id"
          AND "status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING'))
        AND NOT EXISTS (SELECT 1 FROM "FulfillmentGroup" WHERE "orderId" = purchase."id")
      )
  ) THEN
    RAISE EXCEPTION 'manual-resolution order requires exactly one successful payment, expired reservation, open cart, and no fulfillment';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Cart" AS cart_record
    WHERE cart_record."status" = 'CHECKOUT_PENDING'
      AND NOT EXISTS (
        SELECT 1 FROM "Order" AS purchase
        JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
        WHERE purchase."cartId" = cart_record."id" AND purchase."status" = 'PENDING_PAYMENT'
          AND purchase."recoveryReservationId" IS NULL AND reservation."status" = 'ACTIVE'
          AND (SELECT COUNT(*) FROM "PaymentAttempt" WHERE "orderId" = purchase."id"
            AND "status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')) = 1
          AND NOT EXISTS (SELECT 1 FROM "PaymentAttempt" WHERE "orderId" = purchase."id"
            AND "status" = 'SUCCEEDED')
      )
  ) THEN
    RAISE EXCEPTION 'checkout-pending cart has no single active payment attempt';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Cart" AS cart_record
    WHERE cart_record."status" = 'CONVERTED'
      AND (EXISTS (SELECT 1 FROM "CartItem" WHERE "cartId" = cart_record."id")
        OR NOT EXISTS (SELECT 1 FROM "Order" WHERE "cartId" = cart_record."id"
          AND "status" = 'CONFIRMED'))
  ) THEN
    RAISE EXCEPTION 'converted cart has inconsistent checkout state';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "FulfillmentGroupItem" AS item
    JOIN "FulfillmentGroup" AS group_record ON group_record."id" = item."fulfillmentGroupId"
    JOIN "OrderLine" AS line ON line."id" = item."orderLineId"
    WHERE group_record."orderId" <> line."orderId" OR item."quantity" > line."quantity"
  ) THEN
    RAISE EXCEPTION 'fulfillment item does not match its order line';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Order" AS purchase
    WHERE purchase."subtotalMinor" IS DISTINCT FROM COALESCE(
      (SELECT SUM(line."lineSubtotalMinor") FROM "OrderLine" AS line WHERE line."orderId" = purchase."id"), 0)
      OR purchase."taxMinor" IS DISTINCT FROM COALESCE(
        (SELECT SUM(line."lineTaxMinor") FROM "OrderLine" AS line WHERE line."orderId" = purchase."id"), 0)
  ) THEN
    RAISE EXCEPTION 'order totals do not match immutable order lines';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "check_payment_compensation_consistency"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PaymentCompensation" AS compensation
    JOIN "Order" AS purchase ON purchase."id" = compensation."orderId"
    JOIN "PaymentAttempt" AS payment ON payment."id" = compensation."paymentAttemptId"
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    WHERE payment."orderId" <> purchase."id"
       OR payment."status" <> 'SUCCEEDED'
       OR payment."provider" <> compensation."provider"
       OR payment."amountMinor" <> compensation."amountMinor"
       OR payment."currencyCode" <> compensation."currencyCode"
       OR purchase."totalMinor" <> compensation."amountMinor"
       OR purchase."currencyCode" <> compensation."currencyCode"
       OR purchase."status" <> 'MANUAL_RESOLUTION'
       OR purchase."recoveryReservationId" IS NOT NULL
       OR reservation."status" <> 'EXPIRED'
       OR EXISTS (SELECT 1 FROM "FulfillmentGroup" WHERE "orderId" = purchase."id")
  ) THEN
    RAISE EXCEPTION 'payment compensation does not match late-success manual resolution';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Order" AS purchase
    WHERE purchase."status" = 'MANUAL_RESOLUTION'
      AND (SELECT COUNT(*) FROM "PaymentCompensation" WHERE "orderId" = purchase."id") <> 1
  ) THEN
    RAISE EXCEPTION 'manual-resolution order requires exactly one payment compensation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
