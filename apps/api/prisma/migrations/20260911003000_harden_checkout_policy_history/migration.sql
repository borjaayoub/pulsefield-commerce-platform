DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CommercePolicyLifecycle') THEN
    CREATE TYPE "CommercePolicyLifecycle" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
  END IF;
END
$$;

-- The first local rehearsal may have stopped after the additive DDL. These
-- names are all owned by this migration, so dropping them makes the forward
-- migration safely recoverable without resetting commerce data.
ALTER TABLE "CommercePolicyVersion" DROP CONSTRAINT IF EXISTS "CommercePolicyVersion_priceBookVersionId_fkey";
ALTER TABLE "CommercePolicyVersion" DROP CONSTRAINT IF EXISTS "CommercePolicyVersion_effective_window_check";
ALTER TABLE "CommercePolicyVersion" DROP CONSTRAINT IF EXISTS "CommercePolicyVersion_effective_order_check";
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_priceBookVersionId_fkey";
ALTER TABLE "FulfillmentGroupItem" DROP CONSTRAINT IF EXISTS "FulfillmentGroupItem_orderLineId_fkey";
ALTER TABLE "FulfillmentGroupItem" DROP CONSTRAINT IF EXISTS "FulfillmentGroupItem_variantId_fkey";
ALTER TABLE "PaymentAttempt" DROP CONSTRAINT IF EXISTS "PaymentAttempt_provider_identity_check";
ALTER TABLE "PaymentAttempt" DROP CONSTRAINT IF EXISTS "PaymentAttempt_terminal_fields_check";
ALTER TABLE "FulfillmentGroup" DROP CONSTRAINT IF EXISTS "FulfillmentGroup_orderId_warehouseId_key";
DROP INDEX IF EXISTS "CommercePolicyVersion_countryCode_currencyCode_lifecycle_effectiveFrom_idx";
DROP INDEX IF EXISTS "CommercePolicyVersion_one_active_market";
DROP INDEX IF EXISTS "Order_priceBookVersionId_idx";
DROP INDEX IF EXISTS "FulfillmentGroupItem_orderLineId_idx";
DROP INDEX IF EXISTS "PaymentAttempt_provider_providerPaymentId_key";
DROP TRIGGER IF EXISTS "CommercePolicyVersion_protect_history" ON "CommercePolicyVersion";
DROP TRIGGER IF EXISTS "Cart_valid_state_transition" ON "Cart";
DROP TRIGGER IF EXISTS "CartItem_state_guard" ON "CartItem";
DROP TRIGGER IF EXISTS "InventoryReservation_valid_state_transition" ON "InventoryReservation";
DROP TRIGGER IF EXISTS "Order_valid_state_transition" ON "Order";
DROP TRIGGER IF EXISTS "OrderLine_immutable_history" ON "OrderLine";
DROP TRIGGER IF EXISTS "PaymentAttempt_valid_state_transition" ON "PaymentAttempt";
DROP TRIGGER IF EXISTS "FulfillmentGroupItem_immutable_history" ON "FulfillmentGroupItem";
DROP TRIGGER IF EXISTS "Cart_checkout_state_consistency" ON "Cart";
DROP TRIGGER IF EXISTS "CartItem_checkout_state_consistency" ON "CartItem";
DROP TRIGGER IF EXISTS "InventoryReservation_checkout_state_consistency" ON "InventoryReservation";
DROP TRIGGER IF EXISTS "InventoryReservationItem_checkout_state_consistency" ON "InventoryReservationItem";
DROP TRIGGER IF EXISTS "Order_checkout_state_consistency" ON "Order";
DROP TRIGGER IF EXISTS "PaymentAttempt_checkout_state_consistency" ON "PaymentAttempt";
DROP TRIGGER IF EXISTS "FulfillmentGroup_checkout_state_consistency" ON "FulfillmentGroup";
DROP TRIGGER IF EXISTS "FulfillmentGroupItem_checkout_state_consistency" ON "FulfillmentGroupItem";

ALTER TABLE "CommercePolicyVersion"
  ADD COLUMN IF NOT EXISTS "lifecycle" "CommercePolicyLifecycle" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS "effectiveFrom" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "effectiveUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "priceBookVersionId" UUID;

UPDATE "CommercePolicyVersion" AS policy
SET "priceBookVersionId" = version."id",
    "lifecycle" = 'ACTIVE',
    "effectiveFrom" = COALESCE(policy."createdAt", CURRENT_TIMESTAMP)
FROM "PriceBookVersion" AS version
JOIN "PriceBook" AS book ON book."id" = version."priceBookId"
WHERE policy."countryCode" = 'US'
  AND policy."currencyCode" = 'USD'
  AND version."lifecycle" = 'ACTIVE'
  AND book."code" = 'US-RETAIL'
  AND book."marketCode" = 'US'
  AND book."currencyCode" = 'USD';

ALTER TABLE "CommercePolicyVersion" ALTER COLUMN "priceBookVersionId" SET NOT NULL;
ALTER TABLE "CommercePolicyVersion" ADD CONSTRAINT "CommercePolicyVersion_priceBookVersionId_fkey"
  FOREIGN KEY ("priceBookVersionId") REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercePolicyVersion" ADD CONSTRAINT "CommercePolicyVersion_effective_window_check"
  CHECK ("lifecycle" = 'DRAFT' OR "effectiveFrom" IS NOT NULL);
ALTER TABLE "CommercePolicyVersion" ADD CONSTRAINT "CommercePolicyVersion_effective_order_check"
  CHECK ("effectiveUntil" IS NULL OR "effectiveFrom" IS NULL OR "effectiveUntil" > "effectiveFrom");
CREATE INDEX "CommercePolicyVersion_countryCode_currencyCode_lifecycle_effectiveFrom_idx"
  ON "CommercePolicyVersion"("countryCode", "currencyCode", "lifecycle", "effectiveFrom");
CREATE UNIQUE INDEX "CommercePolicyVersion_one_active_market"
  ON "CommercePolicyVersion"("countryCode", "currencyCode") WHERE "lifecycle" = 'ACTIVE';

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "priceBookVersionId" UUID;
UPDATE "Order" AS purchase
SET "priceBookVersionId" = policy."priceBookVersionId"
FROM "CommercePolicyVersion" AS policy
WHERE policy."id" = purchase."policyVersionId";
ALTER TABLE "Order" ALTER COLUMN "priceBookVersionId" SET NOT NULL;
ALTER TABLE "Order" ADD CONSTRAINT "Order_priceBookVersionId_fkey"
  FOREIGN KEY ("priceBookVersionId") REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Order_priceBookVersionId_idx" ON "Order"("priceBookVersionId");

ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "variantNameSnapshot" VARCHAR(160);
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "mediaSnapshot" JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE "OrderLine" AS line
SET "variantNameSnapshot" = variant."name"
FROM "ProductVariant" AS variant
WHERE variant."id" = line."variantId";
ALTER TABLE "OrderLine" ALTER COLUMN "variantNameSnapshot" SET NOT NULL;

ALTER TABLE "FulfillmentGroupItem" ADD COLUMN IF NOT EXISTS "orderLineId" UUID;
UPDATE "FulfillmentGroupItem" AS item
SET "orderLineId" = line."id"
FROM "FulfillmentGroup" AS group_record
     , "OrderLine" AS line
WHERE group_record."id" = item."fulfillmentGroupId"
  AND line."orderId" = group_record."orderId"
  AND line."variantId" = item."variantId";
ALTER TABLE "FulfillmentGroupItem" ALTER COLUMN "orderLineId" SET NOT NULL;
ALTER TABLE "FulfillmentGroupItem" ADD CONSTRAINT "FulfillmentGroupItem_orderLineId_fkey"
  FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX IF EXISTS "FulfillmentGroupItem_fulfillmentGroupId_variantId_key";
ALTER TABLE "FulfillmentGroupItem" DROP COLUMN IF EXISTS "variantId";
CREATE UNIQUE INDEX "FulfillmentGroupItem_fulfillmentGroupId_orderLineId_key"
  ON "FulfillmentGroupItem"("fulfillmentGroupId", "orderLineId");
CREATE INDEX "FulfillmentGroupItem_orderLineId_idx" ON "FulfillmentGroupItem"("orderLineId");

CREATE UNIQUE INDEX "PaymentAttempt_provider_providerPaymentId_key"
  ON "PaymentAttempt"("provider", "providerPaymentId")
  WHERE "providerPaymentId" IS NOT NULL;
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_provider_identity_check"
  CHECK (
    ("status" = 'PROCESSING' AND "providerPaymentId" IS NULL)
    OR ("status" IN ('SUCCEEDED', 'FAILED') AND "providerPaymentId" IS NOT NULL)
  );
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_terminal_fields_check"
  CHECK (
    ("status" <> 'FAILED' OR "failureCode" IS NOT NULL)
    AND ("status" <> 'SUCCEEDED' OR "failureCode" IS NULL)
  );
ALTER TABLE "FulfillmentGroup" ADD CONSTRAINT "FulfillmentGroup_orderId_warehouseId_key"
  UNIQUE ("orderId", "warehouseId");
CREATE INDEX "FulfillmentGroup_status_createdAt_idx" ON "FulfillmentGroup"("status", "createdAt");

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
     ) THEN
    RAISE EXCEPTION 'referenced commerce policy values are immutable';
  END IF;
  IF OLD."lifecycle" = 'ACTIVE'
     AND (
       NEW."lifecycle" <> 'RETIRED'
       OR NEW."countryCode" IS DISTINCT FROM OLD."countryCode"
       OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
       OR NEW."shippingBaseMinor" IS DISTINCT FROM OLD."shippingBaseMinor"
       OR NEW."heavySurchargeMinor" IS DISTINCT FROM OLD."heavySurchargeMinor"
       OR NEW."heavyThresholdGrams" IS DISTINCT FROM OLD."heavyThresholdGrams"
       OR NEW."taxRateBasisPoints" IS DISTINCT FROM OLD."taxRateBasisPoints"
       OR NEW."reservationDurationSeconds" IS DISTINCT FROM OLD."reservationDurationSeconds"
       OR NEW."calculationVersion" IS DISTINCT FROM OLD."calculationVersion"
       OR NEW."priceBookVersionId" IS DISTINCT FROM OLD."priceBookVersionId"
     ) THEN
    RAISE EXCEPTION 'active commerce policy values are immutable';
  END IF;
  IF OLD."lifecycle" = 'DRAFT' AND NEW."lifecycle" = 'RETIRED' THEN
    RAISE EXCEPTION 'draft commerce policies must activate before retirement';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CommercePolicyVersion_protect_history"
  BEFORE UPDATE OR DELETE ON "CommercePolicyVersion"
  FOR EACH ROW EXECUTE FUNCTION "protect_commerce_policy_history"();

CREATE OR REPLACE FUNCTION "enforce_cart_state_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'OPEN' AND NEW."status" = 'CHECKOUT_PENDING')
      OR (OLD."status" = 'CHECKOUT_PENDING' AND NEW."status" IN ('OPEN', 'CONVERTED'))
    ) THEN
      RAISE EXCEPTION 'invalid cart status transition';
    END IF;
    IF NEW."status" = 'CHECKOUT_PENDING'
       AND NOT EXISTS (SELECT 1 FROM "CartItem" WHERE "cartId" = NEW."id") THEN
      RAISE EXCEPTION 'checkout-pending cart must contain an item';
    END IF;
  END IF;
  IF NEW."status" = 'CONVERTED'
     AND EXISTS (SELECT 1 FROM "CartItem" WHERE "cartId" = NEW."id") THEN
    RAISE EXCEPTION 'converted cart must be empty';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Cart_valid_state_transition"
  BEFORE UPDATE ON "Cart"
  FOR EACH ROW EXECUTE FUNCTION "enforce_cart_state_transition"();

CREATE OR REPLACE FUNCTION "enforce_cart_item_state"() RETURNS trigger AS $$
DECLARE cart_status "CartStatus";
BEGIN
  SELECT "status" INTO cart_status
  FROM "Cart"
  WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."cartId" ELSE NEW."cartId" END;
  IF cart_status IN ('CHECKOUT_PENDING', 'CONVERTED') AND TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION 'cart items cannot be changed after checkout begins';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."cartId" IS DISTINCT FROM OLD."cartId" THEN
    RAISE EXCEPTION 'cart item ownership is immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CartItem_state_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "CartItem"
  FOR EACH ROW EXECUTE FUNCTION "enforce_cart_item_state"();

CREATE OR REPLACE FUNCTION "enforce_reservation_state_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'reservation expiry is immutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'ACTIVE' AND NEW."status" IN ('COMMITTED', 'RELEASED')) THEN
    RAISE EXCEPTION 'invalid reservation status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InventoryReservation_valid_state_transition"
  BEFORE UPDATE ON "InventoryReservation"
  FOR EACH ROW EXECUTE FUNCTION "enforce_reservation_state_transition"();

CREATE OR REPLACE FUNCTION "enforce_order_state_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'PENDING_PAYMENT' AND NEW."status" = 'CONFIRMED') THEN
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
CREATE TRIGGER "Order_valid_state_transition"
  BEFORE UPDATE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION "enforce_order_state_transition"();

CREATE OR REPLACE FUNCTION "protect_order_line_history"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order lines are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OrderLine_immutable_history"
  BEFORE UPDATE OR DELETE ON "OrderLine"
  FOR EACH ROW EXECUTE FUNCTION "protect_order_line_history"();

CREATE OR REPLACE FUNCTION "enforce_payment_state_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED')) THEN
    RAISE EXCEPTION 'invalid payment status transition';
  END IF;
  IF OLD."status" IN ('SUCCEEDED', 'FAILED')
     AND (
       NEW."provider" IS DISTINCT FROM OLD."provider"
       OR NEW."paymentMethodReference" IS DISTINCT FROM OLD."paymentMethodReference"
       OR NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
       OR NEW."providerReference" IS DISTINCT FROM OLD."providerReference"
       OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode"
       OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
       OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     ) THEN
    RAISE EXCEPTION 'terminal payment attempts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PaymentAttempt_valid_state_transition"
  BEFORE UPDATE ON "PaymentAttempt"
  FOR EACH ROW EXECUTE FUNCTION "enforce_payment_state_transition"();

CREATE OR REPLACE FUNCTION "protect_fulfillment_item_history"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fulfillment items are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FulfillmentGroupItem_immutable_history"
  BEFORE UPDATE OR DELETE ON "FulfillmentGroupItem"
  FOR EACH ROW EXECUTE FUNCTION "protect_fulfillment_item_history"();

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
      )
  ) THEN
    RAISE EXCEPTION 'processing payment requires pending order, active reservation, and checkout-pending cart';
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
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Cart_checkout_state_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "Cart"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_checkout_state_consistency"();
CREATE CONSTRAINT TRIGGER "CartItem_checkout_state_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "CartItem"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_checkout_state_consistency"();
CREATE CONSTRAINT TRIGGER "InventoryReservation_checkout_state_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "InventoryReservation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_checkout_state_consistency"();
CREATE CONSTRAINT TRIGGER "InventoryReservationItem_checkout_state_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "InventoryReservationItem"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_checkout_state_consistency"();
CREATE CONSTRAINT TRIGGER "Order_checkout_state_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "Order"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_checkout_state_consistency"();
CREATE CONSTRAINT TRIGGER "PaymentAttempt_checkout_state_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "PaymentAttempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_checkout_state_consistency"();
CREATE CONSTRAINT TRIGGER "FulfillmentGroup_checkout_state_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroup"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_checkout_state_consistency"();
CREATE CONSTRAINT TRIGGER "FulfillmentGroupItem_checkout_state_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroupItem"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_checkout_state_consistency"();
