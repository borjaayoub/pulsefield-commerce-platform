-- Phase 3 Slice 3.5: reservation expiry and linear basic fulfillment.
-- This is a forward-only migration. Applied migrations remain immutable.

ALTER TYPE "ReservationStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "InventoryMovementType" ADD VALUE IF NOT EXISTS 'RESERVATION_EXPIRED';
ALTER TYPE "FulfillmentGroupStatus" ADD VALUE IF NOT EXISTS 'PICKING';
ALTER TYPE "FulfillmentGroupStatus" ADD VALUE IF NOT EXISTS 'PACKED';
ALTER TYPE "FulfillmentGroupStatus" ADD VALUE IF NOT EXISTS 'SHIPPED';
ALTER TYPE "FulfillmentGroupStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';

ALTER TABLE "FulfillmentGroup"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "pickingStartedAt" TIMESTAMP(3),
  ADD COLUMN "packedAt" TIMESTAMP(3),
  ADD COLUMN "shippedAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "carrierCode" VARCHAR(32),
  ADD COLUMN "trackingReference" VARCHAR(64),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "FulfillmentGroup"
  ADD CONSTRAINT "FulfillmentGroup_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "FulfillmentGroup_tracking_format_check" CHECK (
    ("carrierCode" IS NULL OR "carrierCode" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$')
    AND ("trackingReference" IS NULL OR "trackingReference" ~ '^[A-Z0-9][A-Z0-9._-]{5,63}$')
  ),
  ADD CONSTRAINT "FulfillmentGroup_status_fields_check" CHECK (
    ("status" = 'ALLOCATED'
      AND "pickingStartedAt" IS NULL
      AND "packedAt" IS NULL
      AND "shippedAt" IS NULL
      AND "deliveredAt" IS NULL
      AND "carrierCode" IS NULL
      AND "trackingReference" IS NULL)
    OR ("status" = 'PICKING'
      AND "pickingStartedAt" IS NOT NULL
      AND "packedAt" IS NULL
      AND "shippedAt" IS NULL
      AND "deliveredAt" IS NULL
      AND "carrierCode" IS NULL
      AND "trackingReference" IS NULL)
    OR ("status" = 'PACKED'
      AND "pickingStartedAt" IS NOT NULL
      AND "packedAt" IS NOT NULL
      AND "shippedAt" IS NULL
      AND "deliveredAt" IS NULL
      AND "carrierCode" IS NULL
      AND "trackingReference" IS NULL)
    OR ("status" = 'SHIPPED'
      AND "pickingStartedAt" IS NOT NULL
      AND "packedAt" IS NOT NULL
      AND "shippedAt" IS NOT NULL
      AND "deliveredAt" IS NULL
      AND "carrierCode" IS NOT NULL
      AND "trackingReference" IS NOT NULL)
    OR ("status" = 'DELIVERED'
      AND "pickingStartedAt" IS NOT NULL
      AND "packedAt" IS NOT NULL
      AND "shippedAt" IS NOT NULL
      AND "deliveredAt" IS NOT NULL
      AND "carrierCode" IS NOT NULL
      AND "trackingReference" IS NOT NULL)
  ),
  ADD CONSTRAINT "FulfillmentGroup_timestamp_order_check" CHECK (
    ("pickingStartedAt" IS NULL OR "pickingStartedAt" >= "createdAt")
    AND ("packedAt" IS NULL OR ("pickingStartedAt" IS NOT NULL AND "packedAt" >= "pickingStartedAt"))
    AND ("shippedAt" IS NULL OR ("packedAt" IS NOT NULL AND "shippedAt" >= "packedAt"))
    AND ("deliveredAt" IS NULL OR ("shippedAt" IS NOT NULL AND "deliveredAt" >= "shippedAt"))
  );

-- Add the expiry movement semantics to the existing append-only ledger guard.
ALTER TABLE "InventoryMovement" DROP CONSTRAINT IF EXISTS "InventoryMovement_type_semantics_check";
ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_type_semantics_check" CHECK (
    ("type" = 'INITIAL_STOCK' AND "onHandDelta" > 0 AND "reservedDelta" = 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
    OR ("type" = 'ADJUSTMENT')
    OR ("type" = 'RESERVED' AND "onHandDelta" = 0 AND "reservedDelta" > 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
    OR ("type" IN ('RESERVATION_RELEASED', 'RESERVATION_EXPIRED') AND "onHandDelta" = 0 AND "reservedDelta" < 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
    OR ("type" = 'RESERVATION_COMMITTED' AND "onHandDelta" = 0 AND "reservedDelta" < 0 AND "allocatedDelta" = -"reservedDelta" AND "damagedDelta" = 0)
    OR ("type" = 'FULFILLMENT_DECREMENT' AND "onHandDelta" < 0 AND "reservedDelta" = 0 AND "allocatedDelta" = "onHandDelta" AND "damagedDelta" = 0)
  );

CREATE OR REPLACE FUNCTION "enforce_reservation_state_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'reservation expiry is immutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'ACTIVE' AND NEW."status" IN ('COMMITTED', 'RELEASED', 'EXPIRED')) THEN
    RAISE EXCEPTION 'invalid reservation status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "enforce_fulfillment_group_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."warehouseId" IS DISTINCT FROM OLD."warehouseId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'fulfillment group identity is immutable';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."pickingStartedAt" IS DISTINCT FROM OLD."pickingStartedAt"
       OR NEW."packedAt" IS DISTINCT FROM OLD."packedAt"
       OR NEW."shippedAt" IS DISTINCT FROM OLD."shippedAt"
       OR NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt"
       OR NEW."carrierCode" IS DISTINCT FROM OLD."carrierCode"
       OR NEW."trackingReference" IS DISTINCT FROM OLD."trackingReference" THEN
      RAISE EXCEPTION 'fulfillment group fields require a status transition';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."version" <> OLD."version" + 1
     OR NOT (
       (OLD."status" = 'ALLOCATED' AND NEW."status" = 'PICKING')
       OR (OLD."status" = 'PICKING' AND NEW."status" = 'PACKED')
       OR (OLD."status" = 'PACKED' AND NEW."status" = 'SHIPPED')
       OR (OLD."status" = 'SHIPPED' AND NEW."status" = 'DELIVERED')
     ) THEN
    RAISE EXCEPTION 'invalid fulfillment group status transition';
  END IF;

  IF (OLD."pickingStartedAt" IS NOT NULL AND NEW."pickingStartedAt" IS DISTINCT FROM OLD."pickingStartedAt")
     OR (OLD."packedAt" IS NOT NULL AND NEW."packedAt" IS DISTINCT FROM OLD."packedAt")
     OR (OLD."shippedAt" IS NOT NULL AND NEW."shippedAt" IS DISTINCT FROM OLD."shippedAt")
     OR (OLD."deliveredAt" IS NOT NULL AND NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt")
     OR (OLD."carrierCode" IS NOT NULL AND NEW."carrierCode" IS DISTINCT FROM OLD."carrierCode")
     OR (OLD."trackingReference" IS NOT NULL AND NEW."trackingReference" IS DISTINCT FROM OLD."trackingReference") THEN
    RAISE EXCEPTION 'fulfillment group history is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "FulfillmentGroup_valid_transition" ON "FulfillmentGroup";
CREATE TRIGGER "FulfillmentGroup_valid_transition"
  BEFORE UPDATE ON "FulfillmentGroup"
  FOR EACH ROW EXECUTE FUNCTION "enforce_fulfillment_group_transition"();

-- Expired reservations are a valid failed-payment projection of a pending order.
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
        AND EXISTS (SELECT 1 FROM "FulfillmentGroup" AS group_record WHERE group_record."orderId" = purchase."id")
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
            OR (payment."status" = 'FAILED' AND cart_record."status" = 'OPEN' AND (
              reservation."status" = 'RELEASED'
              OR (reservation."status" = 'EXPIRED' AND payment."failureCode" = 'RESERVATION_EXPIRED')
            ))
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
        OR NOT EXISTS (SELECT 1 FROM "Order" AS purchase WHERE purchase."cartId" = cart_record."id" AND purchase."status" = 'CONFIRMED')
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
    WHERE purchase."subtotalMinor" IS DISTINCT FROM COALESCE((SELECT SUM(line."lineSubtotalMinor") FROM "OrderLine" AS line WHERE line."orderId" = purchase."id"), 0)
       OR purchase."taxMinor" IS DISTINCT FROM COALESCE((SELECT SUM(line."lineTaxMinor") FROM "OrderLine" AS line WHERE line."orderId" = purchase."id"), 0)
  ) THEN
    RAISE EXCEPTION 'order totals do not match immutable order lines';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Fulfillment transitions keep confirmed orders fully allocated while allowing
-- the group to move through the linear picking/packing/shipping path.
CREATE OR REPLACE FUNCTION "check_phase3_fulfillment_consistency"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    WHERE purchase."status" = 'CONFIRMED'
      AND (
        (SELECT COUNT(*) FROM "FulfillmentGroup" AS group_record WHERE group_record."orderId" = purchase."id") <> 1
        OR EXISTS (
          SELECT 1
          FROM "FulfillmentGroup" AS group_record
          JOIN "FulfillmentGroupItem" AS item ON item."fulfillmentGroupId" = group_record."id"
          JOIN "OrderLine" AS line ON line."id" = item."orderLineId"
          WHERE group_record."orderId" = purchase."id"
            AND (
              line."orderId" <> purchase."id"
              OR NOT EXISTS (
                SELECT 1
                FROM "InventoryReservationItem" AS reservation_item
                WHERE reservation_item."reservationId" = reservation."id"
                  AND reservation_item."variantId" = line."variantId"
                  AND reservation_item."warehouseId" = group_record."warehouseId"
                  AND reservation_item."quantity" = item."quantity"
              )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "OrderLine" AS line
          WHERE line."orderId" = purchase."id"
            AND (
              SELECT COALESCE(SUM(item."quantity"), 0)
              FROM "FulfillmentGroupItem" AS item
              JOIN "FulfillmentGroup" AS group_record ON group_record."id" = item."fulfillmentGroupId"
              WHERE group_record."orderId" = purchase."id" AND item."orderLineId" = line."id"
            ) <> line."quantity"
        )
        OR EXISTS (
          SELECT 1
          FROM "InventoryReservationItem" AS reservation_item
          WHERE reservation_item."reservationId" = reservation."id"
            AND NOT EXISTS (
              SELECT 1
              FROM "FulfillmentGroupItem" AS item
              JOIN "FulfillmentGroup" AS group_record ON group_record."id" = item."fulfillmentGroupId"
              JOIN "OrderLine" AS line ON line."id" = item."orderLineId"
              WHERE group_record."orderId" = purchase."id"
                AND line."orderId" = purchase."id"
                AND line."variantId" = reservation_item."variantId"
                AND group_record."warehouseId" = reservation_item."warehouseId"
                AND item."quantity" = reservation_item."quantity"
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'confirmed Phase 3 order has inconsistent single-warehouse fulfillment';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
