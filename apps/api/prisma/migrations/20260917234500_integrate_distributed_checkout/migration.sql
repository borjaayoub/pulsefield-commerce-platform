ALTER TABLE "InventoryReservation"
  ADD COLUMN "allocationPolicyVersionId" UUID;

CREATE INDEX "InventoryReservation_allocationPolicyVersionId_idx"
  ON "InventoryReservation"("allocationPolicyVersionId");

ALTER TABLE "InventoryReservation"
  ADD CONSTRAINT "InventoryReservation_allocationPolicyVersionId_fkey"
  FOREIGN KEY ("allocationPolicyVersionId")
  REFERENCES "InventoryAllocationPolicyVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION protect_reservation_allocation_policy_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."allocationPolicyVersionId" IS DISTINCT FROM OLD."allocationPolicyVersionId" THEN
    RAISE EXCEPTION 'reservation allocation policy snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "InventoryReservation_allocation_policy_immutable"
BEFORE UPDATE ON "InventoryReservation"
FOR EACH ROW EXECUTE FUNCTION protect_reservation_allocation_policy_snapshot();

DROP TRIGGER IF EXISTS "Order_phase3_fulfillment_consistency" ON "Order";
DROP TRIGGER IF EXISTS "InventoryReservation_phase3_fulfillment_consistency"
  ON "InventoryReservation";
DROP TRIGGER IF EXISTS "InventoryReservationItem_phase3_fulfillment_consistency"
  ON "InventoryReservationItem";
DROP TRIGGER IF EXISTS "FulfillmentGroup_phase3_fulfillment_consistency"
  ON "FulfillmentGroup";
DROP TRIGGER IF EXISTS "FulfillmentGroupItem_phase3_fulfillment_consistency"
  ON "FulfillmentGroupItem";
DROP FUNCTION IF EXISTS "check_phase3_fulfillment_consistency"();

CREATE OR REPLACE FUNCTION check_distributed_fulfillment_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    WHERE purchase."status" = 'CONFIRMED'
      AND (
        NOT EXISTS (
          SELECT 1 FROM "FulfillmentGroup" AS group_record
          WHERE group_record."orderId" = purchase."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "OrderLine" AS line
          WHERE line."orderId" = purchase."id"
            AND (
              SELECT COALESCE(SUM(reservation_item."quantity"), 0)
              FROM "InventoryReservationItem" AS reservation_item
              WHERE reservation_item."reservationId" = COALESCE(
                purchase."recoveryReservationId",
                purchase."reservationId"
              )
                AND reservation_item."variantId" = line."variantId"
            ) <> line."quantity"
        )
        OR EXISTS (
          SELECT 1
          FROM "InventoryReservationItem" AS reservation_item
          WHERE reservation_item."reservationId" = COALESCE(
              purchase."recoveryReservationId",
              purchase."reservationId"
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "OrderLine" AS line
              WHERE line."orderId" = purchase."id"
                AND line."variantId" = reservation_item."variantId"
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "InventoryReservationItem" AS reservation_item
          WHERE reservation_item."reservationId" = COALESCE(
              purchase."recoveryReservationId",
              purchase."reservationId"
            )
            AND (
              SELECT COUNT(*)
              FROM "FulfillmentGroup" AS group_record
              JOIN "FulfillmentGroupItem" AS item
                ON item."fulfillmentGroupId" = group_record."id"
              JOIN "OrderLine" AS line ON line."id" = item."orderLineId"
              WHERE group_record."orderId" = purchase."id"
                AND group_record."warehouseId" = reservation_item."warehouseId"
                AND line."orderId" = purchase."id"
                AND line."variantId" = reservation_item."variantId"
                AND item."quantity" = reservation_item."quantity"
            ) <> 1
        )
        OR EXISTS (
          SELECT 1
          FROM "FulfillmentGroup" AS group_record
          JOIN "FulfillmentGroupItem" AS item
            ON item."fulfillmentGroupId" = group_record."id"
          JOIN "OrderLine" AS line ON line."id" = item."orderLineId"
          WHERE group_record."orderId" = purchase."id"
            AND (
              line."orderId" <> purchase."id"
              OR NOT EXISTS (
                SELECT 1
                FROM "InventoryReservationItem" AS reservation_item
                WHERE reservation_item."reservationId" = COALESCE(
                    purchase."recoveryReservationId",
                    purchase."reservationId"
                  )
                  AND reservation_item."warehouseId" = group_record."warehouseId"
                  AND reservation_item."variantId" = line."variantId"
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
      )
  ) THEN
    RAISE EXCEPTION 'confirmed order has inconsistent distributed fulfillment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_distributed_fulfillment_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "Order"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_distributed_fulfillment_consistency();

CREATE CONSTRAINT TRIGGER "InventoryReservation_distributed_fulfillment_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "InventoryReservation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_distributed_fulfillment_consistency();

CREATE CONSTRAINT TRIGGER "InventoryReservationItem_distributed_fulfillment_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "InventoryReservationItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_distributed_fulfillment_consistency();

CREATE CONSTRAINT TRIGGER "FulfillmentGroup_distributed_fulfillment_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroup"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_distributed_fulfillment_consistency();

CREATE CONSTRAINT TRIGGER "FulfillmentGroupItem_distributed_fulfillment_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroupItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_distributed_fulfillment_consistency();
