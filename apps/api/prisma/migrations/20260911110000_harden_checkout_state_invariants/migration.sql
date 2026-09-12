-- Keep the applied checkout migration immutable. This forward migration adds
-- the missing read indexes and closes historical-policy loopholes.
CREATE INDEX IF NOT EXISTS "Cart_status_updatedAt_idx"
  ON "Cart"("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "InventoryReservation_status_updatedAt_idx"
  ON "InventoryReservation"("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "OrderLine_variantId_idx"
  ON "OrderLine"("variantId");
CREATE INDEX IF NOT EXISTS "PaymentAttempt_status_updatedAt_idx"
  ON "PaymentAttempt"("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "FulfillmentGroup_status_createdAt_idx"
  ON "FulfillmentGroup"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "FulfillmentGroupItem_orderLineId_idx"
  ON "FulfillmentGroupItem"("orderLineId");

DROP TRIGGER IF EXISTS "CommercePolicyVersion_protect_history" ON "CommercePolicyVersion";
CREATE OR REPLACE FUNCTION "protect_commerce_policy_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."lifecycle" IN ('ACTIVE', 'RETIRED')
       OR EXISTS (SELECT 1 FROM "Order" WHERE "policyVersionId" = OLD."id") THEN
      RAISE EXCEPTION 'referenced, active, or retired commerce policies are immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."lifecycle" <> 'DRAFT' AND NEW."effectiveFrom" IS NULL THEN
    RAISE EXCEPTION 'active and retired commerce policies require effectiveFrom';
  END IF;
  IF OLD."lifecycle" = 'RETIRED' THEN
    RAISE EXCEPTION 'retired commerce policies are immutable';
  END IF;
  IF OLD."lifecycle" = 'DRAFT' AND NEW."lifecycle" = 'RETIRED' THEN
    RAISE EXCEPTION 'draft commerce policies must activate before retirement';
  END IF;
  IF EXISTS (SELECT 1 FROM "Order" WHERE "policyVersionId" = OLD."id")
     AND (
       NEW."countryCode" IS DISTINCT FROM OLD."countryCode"
       OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
       OR NEW."shippingBaseMinor" IS DISTINCT FROM OLD."shippingBaseMinor"
       OR NEW."freeShippingThresholdMinor" IS DISTINCT FROM OLD."freeShippingThresholdMinor"
       OR NEW."heavySurchargeMinor" IS DISTINCT FROM OLD."heavySurchargeMinor"
       OR NEW."heavyThresholdGrams" IS DISTINCT FROM OLD."heavyThresholdGrams"
       OR NEW."taxRateBasisPoints" IS DISTINCT FROM OLD."taxRateBasisPoints"
       OR NEW."reservationDurationSeconds" IS DISTINCT FROM OLD."reservationDurationSeconds"
       OR NEW."calculationVersion" IS DISTINCT FROM OLD."calculationVersion"
       OR NEW."priceBookVersionId" IS DISTINCT FROM OLD."priceBookVersionId"
       OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
     ) THEN
    RAISE EXCEPTION 'referenced commerce policy values are immutable';
  END IF;
  IF OLD."lifecycle" = 'ACTIVE'
     AND (
       NEW."lifecycle" <> 'RETIRED'
       OR NEW."countryCode" IS DISTINCT FROM OLD."countryCode"
       OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
       OR NEW."shippingBaseMinor" IS DISTINCT FROM OLD."shippingBaseMinor"
       OR NEW."freeShippingThresholdMinor" IS DISTINCT FROM OLD."freeShippingThresholdMinor"
       OR NEW."heavySurchargeMinor" IS DISTINCT FROM OLD."heavySurchargeMinor"
       OR NEW."heavyThresholdGrams" IS DISTINCT FROM OLD."heavyThresholdGrams"
       OR NEW."taxRateBasisPoints" IS DISTINCT FROM OLD."taxRateBasisPoints"
       OR NEW."reservationDurationSeconds" IS DISTINCT FROM OLD."reservationDurationSeconds"
       OR NEW."calculationVersion" IS DISTINCT FROM OLD."calculationVersion"
       OR NEW."priceBookVersionId" IS DISTINCT FROM OLD."priceBookVersionId"
       OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
     ) THEN
    RAISE EXCEPTION 'active commerce policy values are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CommercePolicyVersion_protect_history"
  BEFORE UPDATE OR DELETE ON "CommercePolicyVersion"
  FOR EACH ROW EXECUTE FUNCTION "protect_commerce_policy_history"();

CREATE OR REPLACE FUNCTION "check_active_commerce_policy_price_book"() RETURNS trigger AS $$
DECLARE version_lifecycle "PriceBookVersionLifecycle";
DECLARE book_market CHAR(2);
DECLARE book_currency CHAR(3);
BEGIN
  IF NEW."lifecycle" <> 'ACTIVE' THEN RETURN NEW; END IF;
  SELECT version."lifecycle", book."marketCode", book."currencyCode"
    INTO version_lifecycle, book_market, book_currency
  FROM "PriceBookVersion" AS version
  JOIN "PriceBook" AS book ON book."id" = version."priceBookId"
  WHERE version."id" = NEW."priceBookVersionId";
  IF version_lifecycle IS DISTINCT FROM 'ACTIVE'
     OR book_market IS DISTINCT FROM NEW."countryCode"
     OR book_currency IS DISTINCT FROM NEW."currencyCode" THEN
    RAISE EXCEPTION 'active commerce policy requires an active matching price book version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "CommercePolicyVersion_active_price_book" ON "CommercePolicyVersion";
CREATE TRIGGER "CommercePolicyVersion_active_price_book"
  BEFORE INSERT OR UPDATE ON "CommercePolicyVersion"
  FOR EACH ROW EXECUTE FUNCTION "check_active_commerce_policy_price_book"();

CREATE OR REPLACE FUNCTION "protect_policy_price_book_history"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CommercePolicyVersion"
    WHERE "priceBookVersionId" = OLD."id" AND "lifecycle" = 'ACTIVE'
  ) AND (
    NEW."lifecycle" IS DISTINCT FROM OLD."lifecycle"
    OR NEW."priceBookId" IS DISTINCT FROM OLD."priceBookId"
    OR NEW."version" IS DISTINCT FROM OLD."version"
  ) THEN
    RAISE EXCEPTION 'price book version used by an active commerce policy is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "PriceBookVersion_active_policy_guard" ON "PriceBookVersion";
CREATE TRIGGER "PriceBookVersion_active_policy_guard"
  BEFORE UPDATE ON "PriceBookVersion"
  FOR EACH ROW EXECUTE FUNCTION "protect_policy_price_book_history"();

CREATE OR REPLACE FUNCTION "check_checkout_state_consistency"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    JOIN "PaymentAttempt" AS payment ON payment."orderId" = purchase."id"
    WHERE payment."status" = 'PROCESSING'
      AND NOT (
        purchase."status" = 'PENDING_PAYMENT'
        AND reservation."status" = 'ACTIVE'
        AND cart_record."status" = 'CHECKOUT_PENDING'
        AND payment."amountMinor" = purchase."totalMinor"
        AND payment."currencyCode" = purchase."currencyCode"
      )
  ) THEN
    RAISE EXCEPTION 'processing payment requires pending order, active reservation, checkout-pending cart, and matching amount';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    JOIN "Cart" AS cart_record ON cart_record."id" = purchase."cartId"
    JOIN "PaymentAttempt" AS payment ON payment."orderId" = purchase."id"
    WHERE payment."status" = 'SUCCEEDED'
      AND NOT (
        purchase."status" = 'CONFIRMED'
        AND reservation."status" = 'COMMITTED'
        AND cart_record."status" = 'CONVERTED'
        AND NOT EXISTS (SELECT 1 FROM "CartItem" WHERE "cartId" = cart_record."id")
        AND payment."amountMinor" = purchase."totalMinor"
        AND payment."currencyCode" = purchase."currencyCode"
        AND EXISTS (
          SELECT 1 FROM "FulfillmentGroup" AS group_record
          WHERE group_record."orderId" = purchase."id" AND group_record."status" = 'ALLOCATED'
        )
      )
  ) THEN
    RAISE EXCEPTION 'successful payment requires confirmed order, committed reservation, converted cart, and allocation';
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
        AND reservation."status" = 'RELEASED'
        AND cart_record."status" = 'OPEN'
        AND payment."amountMinor" = purchase."totalMinor"
        AND payment."currencyCode" = purchase."currencyCode"
        AND NOT EXISTS (SELECT 1 FROM "FulfillmentGroup" WHERE "orderId" = purchase."id")
      )
  ) THEN
    RAISE EXCEPTION 'failed payment requires released reservation and open cart';
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
        AND EXISTS (SELECT 1 FROM "PaymentAttempt" WHERE "orderId" = purchase."id" AND "status" = 'SUCCEEDED')
      )
  ) THEN
    RAISE EXCEPTION 'confirmed order has inconsistent checkout state';
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
            (payment."status" = 'PROCESSING' AND reservation."status" = 'ACTIVE' AND cart_record."status" = 'CHECKOUT_PENDING')
            OR (payment."status" = 'FAILED' AND reservation."status" = 'RELEASED' AND cart_record."status" = 'OPEN')
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
          AND payment."status" = 'PROCESSING'
      )
  ) THEN
    RAISE EXCEPTION 'checkout-pending cart has no processing checkout';
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
    WHERE purchase."subtotalMinor" IS DISTINCT FROM COALESCE((
      SELECT SUM(line."lineSubtotalMinor") FROM "OrderLine" AS line WHERE line."orderId" = purchase."id"
    ), 0)
       OR purchase."taxMinor" IS DISTINCT FROM COALESCE((
      SELECT SUM(line."lineTaxMinor") FROM "OrderLine" AS line WHERE line."orderId" = purchase."id"
    ), 0)
  ) THEN
    RAISE EXCEPTION 'order totals do not match immutable order lines';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
