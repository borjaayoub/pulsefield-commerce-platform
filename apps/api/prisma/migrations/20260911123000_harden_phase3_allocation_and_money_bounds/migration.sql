-- Phase 3 uses one deterministic US warehouse and JavaScript-safe checkout values.
ALTER TABLE "CommercePolicyVersion"
  ADD CONSTRAINT "CommercePolicyVersion_rate_duration_check"
  CHECK (
    "taxRateBasisPoints" BETWEEN 0 AND 10000
    AND "reservationDurationSeconds" BETWEEN 1 AND 86400
  );

CREATE UNIQUE INDEX "OrderLine_orderId_variantId_key"
  ON "OrderLine"("orderId", "variantId");

-- Confirmed Phase 3 orders must be fully and immutably allocated from one warehouse.
CREATE OR REPLACE FUNCTION "check_phase3_fulfillment_consistency"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "InventoryReservation" AS reservation
      ON reservation."id" = purchase."reservationId"
    WHERE purchase."status" = 'CONFIRMED'
      AND (
        (SELECT COUNT(*) FROM "FulfillmentGroup" AS group_record
         WHERE group_record."orderId" = purchase."id") <> 1
        OR EXISTS (
          SELECT 1
          FROM "FulfillmentGroup" AS group_record
          JOIN "FulfillmentGroupItem" AS item
            ON item."fulfillmentGroupId" = group_record."id"
          JOIN "OrderLine" AS line
            ON line."id" = item."orderLineId"
          WHERE group_record."orderId" = purchase."id"
            AND (
              group_record."status" <> 'ALLOCATED'
              OR line."orderId" <> purchase."id"
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
              JOIN "FulfillmentGroup" AS group_record
                ON group_record."id" = item."fulfillmentGroupId"
              WHERE group_record."orderId" = purchase."id"
                AND item."orderLineId" = line."id"
            ) <> line."quantity"
        )
        OR EXISTS (
          SELECT 1
          FROM "InventoryReservationItem" AS reservation_item
          WHERE reservation_item."reservationId" = reservation."id"
            AND NOT EXISTS (
              SELECT 1
              FROM "FulfillmentGroupItem" AS item
              JOIN "FulfillmentGroup" AS group_record
                ON group_record."id" = item."fulfillmentGroupId"
              JOIN "OrderLine" AS line
                ON line."id" = item."orderLineId"
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

DROP TRIGGER IF EXISTS "Order_phase3_fulfillment_consistency" ON "Order";
CREATE CONSTRAINT TRIGGER "Order_phase3_fulfillment_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "Order"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "check_phase3_fulfillment_consistency"();

DROP TRIGGER IF EXISTS "InventoryReservation_phase3_fulfillment_consistency"
  ON "InventoryReservation";
CREATE CONSTRAINT TRIGGER "InventoryReservation_phase3_fulfillment_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "InventoryReservation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "check_phase3_fulfillment_consistency"();

DROP TRIGGER IF EXISTS "InventoryReservationItem_phase3_fulfillment_consistency"
  ON "InventoryReservationItem";
CREATE CONSTRAINT TRIGGER "InventoryReservationItem_phase3_fulfillment_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "InventoryReservationItem"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "check_phase3_fulfillment_consistency"();

DROP TRIGGER IF EXISTS "FulfillmentGroup_phase3_fulfillment_consistency"
  ON "FulfillmentGroup";
CREATE CONSTRAINT TRIGGER "FulfillmentGroup_phase3_fulfillment_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroup"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "check_phase3_fulfillment_consistency"();

DROP TRIGGER IF EXISTS "FulfillmentGroupItem_phase3_fulfillment_consistency"
  ON "FulfillmentGroupItem";
CREATE CONSTRAINT TRIGGER "FulfillmentGroupItem_phase3_fulfillment_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroupItem"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "check_phase3_fulfillment_consistency"();
