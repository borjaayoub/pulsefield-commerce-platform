-- Make checkout consistency order-state based so failed attempt history can be
-- retained while exactly one current non-terminal or successful attempt governs
-- the order projection. Previously applied migrations remain immutable.

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
      AND NOT (
        (
          reservation."status" = 'ACTIVE'
          AND cart_record."status" = 'CHECKOUT_PENDING'
          AND NOT EXISTS (
            SELECT 1 FROM "FulfillmentGroup" AS group_record
            WHERE group_record."orderId" = purchase."id"
          )
          AND (
            SELECT COUNT(*) FROM "PaymentAttempt" AS payment
            WHERE payment."orderId" = purchase."id"
              AND payment."status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')
          ) = 1
          AND NOT EXISTS (
            SELECT 1 FROM "PaymentAttempt" AS payment
            WHERE payment."orderId" = purchase."id" AND payment."status" = 'SUCCEEDED'
          )
        )
        OR (
          reservation."status" IN ('RELEASED', 'EXPIRED')
          AND cart_record."status" = 'OPEN'
          AND NOT EXISTS (
            SELECT 1 FROM "FulfillmentGroup" AS group_record
            WHERE group_record."orderId" = purchase."id"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "PaymentAttempt" AS payment
            WHERE payment."orderId" = purchase."id"
              AND payment."status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING', 'SUCCEEDED')
          )
          AND EXISTS (
            SELECT 1 FROM "PaymentAttempt" AS payment
            WHERE payment."orderId" = purchase."id"
              AND payment."status" = 'FAILED'
              AND (
                (
                  reservation."status" = 'RELEASED'
                  AND payment."failureCode" <> 'RESERVATION_EXPIRED'
                )
                OR (
                  reservation."status" = 'EXPIRED'
                  AND payment."failureCode" = 'RESERVATION_EXPIRED'
                )
              )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'pending order has inconsistent active or terminal-failure checkout state';
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
        AND (
          SELECT COUNT(*) FROM "PaymentAttempt" AS payment
          WHERE payment."orderId" = purchase."id" AND payment."status" = 'SUCCEEDED'
        ) = 1
        AND NOT EXISTS (
          SELECT 1 FROM "PaymentAttempt" AS payment
          WHERE payment."orderId" = purchase."id"
            AND payment."status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')
        )
        AND EXISTS (
          SELECT 1 FROM "FulfillmentGroup" AS group_record
          WHERE group_record."orderId" = purchase."id"
        )
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
        reservation."status" = 'EXPIRED'
        AND cart_record."status" = 'OPEN'
        AND (
          SELECT COUNT(*) FROM "PaymentAttempt" AS payment
          WHERE payment."orderId" = purchase."id" AND payment."status" = 'SUCCEEDED'
        ) = 1
        AND NOT EXISTS (
          SELECT 1 FROM "PaymentAttempt" AS payment
          WHERE payment."orderId" = purchase."id"
            AND payment."status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')
        )
        AND NOT EXISTS (
          SELECT 1 FROM "FulfillmentGroup" AS group_record
          WHERE group_record."orderId" = purchase."id"
        )
      )
  ) THEN
    RAISE EXCEPTION 'manual-resolution order requires exactly one successful payment, expired reservation, open cart, and no fulfillment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Cart" AS cart_record
    WHERE cart_record."status" = 'CHECKOUT_PENDING'
      AND NOT EXISTS (
        SELECT 1
        FROM "Order" AS purchase
        JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
        WHERE purchase."cartId" = cart_record."id"
          AND purchase."status" = 'PENDING_PAYMENT'
          AND reservation."status" = 'ACTIVE'
          AND (
            SELECT COUNT(*) FROM "PaymentAttempt" AS payment
            WHERE payment."orderId" = purchase."id"
              AND payment."status" IN ('REQUIRES_PAYMENT_METHOD', 'PROCESSING')
          ) = 1
          AND NOT EXISTS (
            SELECT 1 FROM "PaymentAttempt" AS payment
            WHERE payment."orderId" = purchase."id" AND payment."status" = 'SUCCEEDED'
          )
      )
  ) THEN
    RAISE EXCEPTION 'checkout-pending cart has no single active payment attempt';
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
