-- Phase 3 Slice 3.5 forward hardening: fulfillment groups may only be
-- created in their initial allocated state.

CREATE OR REPLACE FUNCTION "enforce_fulfillment_group_transition"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ALLOCATED'
       OR NEW."version" <> 1
       OR NEW."pickingStartedAt" IS NOT NULL
       OR NEW."packedAt" IS NOT NULL
       OR NEW."shippedAt" IS NOT NULL
       OR NEW."deliveredAt" IS NOT NULL
       OR NEW."carrierCode" IS NOT NULL
       OR NEW."trackingReference" IS NOT NULL THEN
      RAISE EXCEPTION 'fulfillment groups must start in allocated state';
    END IF;
    RETURN NEW;
  END IF;

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
  BEFORE INSERT OR UPDATE ON "FulfillmentGroup"
  FOR EACH ROW EXECUTE FUNCTION "enforce_fulfillment_group_transition"();
