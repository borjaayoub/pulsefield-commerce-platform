-- Reconcile the Phase 3 commerce guards with the approved Phase 4 lifecycle.
-- Existing applied migrations remain immutable; these definitions supersede them.

DROP TRIGGER IF EXISTS "PaymentAttempt_valid_state_transition" ON "PaymentAttempt";
DROP FUNCTION IF EXISTS "enforce_payment_state_transition"();

ALTER TABLE "PaymentAttempt"
  DROP CONSTRAINT IF EXISTS "PaymentAttempt_provider_identity_check";
ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_provider_identity_check" CHECK (
    ("status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING'))
    OR ("status" IN ('SUCCEEDED', 'FAILED') AND "providerPaymentId" IS NOT NULL)
  );

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

CREATE OR REPLACE FUNCTION "check_checkout_state_consistency"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    JOIN "PaymentAttempt" AS payment ON payment."orderId" = purchase."id"
    WHERE payment."status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')
      AND NOT (
        purchase."status" = 'PENDING_PAYMENT'
        AND reservation."status" = 'ACTIVE'
        AND cart_record."status" = 'CHECKOUT_PENDING'
        AND payment."amountMinor" = purchase."totalMinor"
        AND payment."currencyCode" = purchase."currencyCode"
      )
  ) THEN
    RAISE EXCEPTION 'non-terminal payment requires pending order, active reservation, checkout-pending cart, and matching amount';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    JOIN "PaymentAttempt" AS payment ON payment."orderId" = purchase."id"
    WHERE payment."status" = 'SUCCEEDED'
      AND NOT (
        payment."amountMinor" = purchase."totalMinor"
        AND payment."currencyCode" = purchase."currencyCode"
        AND (
          (
            purchase."status" = 'CONFIRMED'
            AND reservation."status" = 'COMMITTED'
            AND cart_record."status" = 'CONVERTED'
            AND NOT EXISTS (SELECT 1 FROM "CartItem" WHERE "cartId" = cart_record."id")
            AND EXISTS (
              SELECT 1 FROM "FulfillmentGroup" AS group_record
              WHERE group_record."orderId" = purchase."id"
            )
          )
          OR (
            purchase."status" = 'MANUAL_RESOLUTION'
            AND reservation."status" = 'EXPIRED'
            AND cart_record."status" = 'OPEN'
            AND NOT EXISTS (
              SELECT 1 FROM "FulfillmentGroup" AS group_record
              WHERE group_record."orderId" = purchase."id"
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'successful payment requires a confirmed allocation or the late-success manual-resolution projection';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    JOIN "PaymentAttempt" AS payment ON payment."orderId" = purchase."id"
    WHERE payment."status" = 'FAILED'
      AND NOT (
        purchase."status" = 'PENDING_PAYMENT'
        AND cart_record."status" = 'OPEN'
        AND payment."amountMinor" = purchase."totalMinor"
        AND payment."currencyCode" = purchase."currencyCode"
        AND (
          (reservation."status" = 'RELEASED' AND payment."failureCode" <> 'RESERVATION_EXPIRED')
          OR (reservation."status" = 'EXPIRED' AND payment."failureCode" = 'RESERVATION_EXPIRED')
        )
        AND NOT EXISTS (SELECT 1 FROM "FulfillmentGroup" WHERE "orderId" = purchase."id")
      )
  ) THEN
    RAISE EXCEPTION 'failed payment requires released or expired reservation and open cart';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    WHERE purchase."status" = 'CONFIRMED'
      AND NOT (
        reservation."status" = 'COMMITTED'
        AND cart_record."status" = 'CONVERTED'
        AND NOT EXISTS (SELECT 1 FROM "CartItem" WHERE "cartId" = cart_record."id")
        AND EXISTS (
          SELECT 1 FROM "PaymentAttempt"
          WHERE "orderId" = purchase."id" AND "status" = 'SUCCEEDED'
        )
      )
  ) THEN
    RAISE EXCEPTION 'confirmed order has inconsistent checkout state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    WHERE purchase."status" = 'MANUAL_RESOLUTION'
      AND NOT (
        reservation."status" = 'EXPIRED'
        AND cart_record."status" = 'OPEN'
        AND NOT EXISTS (
          SELECT 1 FROM "FulfillmentGroup" AS group_record
          WHERE group_record."orderId" = purchase."id"
        )
        AND (SELECT COUNT(*) FROM "PaymentAttempt" WHERE "orderId" = purchase."id") = 1
        AND EXISTS (
          SELECT 1 FROM "PaymentAttempt" AS payment
          WHERE payment."orderId" = purchase."id"
            AND payment."status" = 'SUCCEEDED'
            AND payment."amountMinor" = purchase."totalMinor"
            AND payment."currencyCode" = purchase."currencyCode"
        )
      )
  ) THEN
    RAISE EXCEPTION 'manual-resolution order requires one successful payment, expired reservation, open cart, and no fulfillment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    WHERE purchase."status" = 'PENDING_PAYMENT'
      AND NOT EXISTS (
        SELECT 1 FROM "PaymentAttempt" AS payment
        WHERE payment."orderId" = purchase."id"
          AND (
            (
              payment."status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')
              AND reservation."status" = 'ACTIVE'
              AND cart_record."status" = 'CHECKOUT_PENDING'
            )
            OR (
              payment."status" = 'FAILED'
              AND cart_record."status" = 'OPEN'
              AND (
                reservation."status" = 'RELEASED'
                OR (
                  reservation."status" = 'EXPIRED'
                  AND payment."failureCode" = 'RESERVATION_EXPIRED'
                )
              )
            )
          )
      )
  ) THEN
    RAISE EXCEPTION 'pending order has inconsistent checkout state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Cart" AS cart_record
    WHERE cart_record."status" = 'CHECKOUT_PENDING'
      AND NOT EXISTS (
        SELECT 1
        FROM "Order" AS purchase
        JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
        JOIN "PaymentAttempt" AS payment ON payment."orderId" = purchase."id"
        WHERE purchase."cartId" = cart_record."id"
          AND purchase."status" = 'PENDING_PAYMENT'
          AND reservation."status" = 'ACTIVE'
          AND payment."status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')
      )
  ) THEN
    RAISE EXCEPTION 'checkout-pending cart has no non-terminal checkout';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Cart" AS cart_record
    WHERE cart_record."status" = 'CONVERTED'
      AND (
        EXISTS (SELECT 1 FROM "CartItem" WHERE "cartId" = cart_record."id")
        OR NOT EXISTS (
          SELECT 1 FROM "Order" AS purchase
          WHERE purchase."cartId" = cart_record."id" AND purchase."status" = 'CONFIRMED'
        )
      )
  ) THEN
    RAISE EXCEPTION 'converted cart has inconsistent checkout state';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "FulfillmentGroupItem" AS item
    JOIN "FulfillmentGroup" AS group_record ON group_record."id" = item."fulfillmentGroupId"
    JOIN "OrderLine" AS line ON line."id" = item."orderLineId"
    WHERE group_record."orderId" <> line."orderId"
       OR item."quantity" > line."quantity"
  ) THEN
    RAISE EXCEPTION 'fulfillment item does not match its order line';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    WHERE purchase."subtotalMinor" IS DISTINCT FROM COALESCE(
      (SELECT SUM(line."lineSubtotalMinor") FROM "OrderLine" AS line WHERE line."orderId" = purchase."id"),
      0
    )
      OR purchase."taxMinor" IS DISTINCT FROM COALESCE(
        (SELECT SUM(line."lineTaxMinor") FROM "OrderLine" AS line WHERE line."orderId" = purchase."id"),
        0
      )
  ) THEN
    RAISE EXCEPTION 'order totals do not match immutable order lines';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
