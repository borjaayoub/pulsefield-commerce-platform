CREATE OR REPLACE FUNCTION check_fulfillment_shipment_movements()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "FulfillmentGroup" AS group_record
    WHERE (
      group_record."status" IN ('SHIPPED', 'DELIVERED')
      AND (
        (SELECT COUNT(*)
         FROM "InventoryMovement" AS movement
         WHERE movement."commandId" = group_record."id"
           AND movement."type" = 'FULFILLMENT_DECREMENT')
        <>
        (SELECT COUNT(*)
         FROM "FulfillmentGroupItem" AS item
         WHERE item."fulfillmentGroupId" = group_record."id")
        OR EXISTS (
          SELECT 1
          FROM "FulfillmentGroupItem" AS item
          JOIN "OrderLine" AS line ON line."id" = item."orderLineId"
          WHERE item."fulfillmentGroupId" = group_record."id"
            AND (SELECT COUNT(*)
                 FROM "InventoryMovement" AS movement
                 WHERE movement."commandId" = group_record."id"
                   AND movement."type" = 'FULFILLMENT_DECREMENT'
                   AND movement."warehouseId" = group_record."warehouseId"
                   AND movement."variantId" = line."variantId"
                   AND movement."onHandDelta" = -item."quantity"
                   AND movement."allocatedDelta" = -item."quantity")
                <>
                (SELECT COUNT(*)
                 FROM "FulfillmentGroupItem" AS matching_item
                 JOIN "OrderLine" AS matching_line ON matching_line."id" = matching_item."orderLineId"
                 WHERE matching_item."fulfillmentGroupId" = group_record."id"
                   AND matching_line."variantId" = line."variantId"
                   AND matching_item."quantity" = item."quantity")
        )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM "FulfillmentGroup" AS group_record
      WHERE group_record."status" NOT IN ('SHIPPED', 'DELIVERED')
        AND EXISTS (
          SELECT 1
          FROM "InventoryMovement" AS movement
          WHERE movement."commandId" = group_record."id"
            AND movement."type" = 'FULFILLMENT_DECREMENT'
        )
    )
  ) THEN
    RAISE EXCEPTION 'fulfillment shipment movements do not match group allocation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "FulfillmentGroup_shipment_movements"
AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroup"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_fulfillment_shipment_movements();

CREATE CONSTRAINT TRIGGER "FulfillmentGroupItem_shipment_movements"
AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroupItem"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_fulfillment_shipment_movements();

CREATE CONSTRAINT TRIGGER "InventoryMovement_fulfillment_shipment_movements"
AFTER INSERT OR UPDATE OR DELETE ON "InventoryMovement"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_fulfillment_shipment_movements();
