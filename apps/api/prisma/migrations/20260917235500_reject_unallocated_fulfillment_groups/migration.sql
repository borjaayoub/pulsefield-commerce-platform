CREATE OR REPLACE FUNCTION reject_unallocated_fulfillment_groups()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    JOIN "FulfillmentGroup" AS group_record
      ON group_record."orderId" = purchase."id"
    WHERE purchase."status" = 'CONFIRMED'
      AND NOT EXISTS (
        SELECT 1
        FROM "InventoryReservationItem" AS reservation_item
        WHERE reservation_item."reservationId" = COALESCE(
            purchase."recoveryReservationId",
            purchase."reservationId"
          )
          AND reservation_item."warehouseId" = group_record."warehouseId"
      )
  ) THEN
    RAISE EXCEPTION 'fulfillment group has no committed warehouse allocation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Order_no_unallocated_fulfillment_group"
AFTER INSERT OR UPDATE OR DELETE ON "Order"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION reject_unallocated_fulfillment_groups();

CREATE CONSTRAINT TRIGGER "InventoryReservationItem_no_unallocated_fulfillment_group"
AFTER INSERT OR UPDATE OR DELETE ON "InventoryReservationItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION reject_unallocated_fulfillment_groups();

CREATE CONSTRAINT TRIGGER "FulfillmentGroup_no_unallocated_fulfillment_group"
AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroup"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION reject_unallocated_fulfillment_groups();
