CREATE TYPE "FulfillmentRegion" AS ENUM ('US', 'MOROCCO', 'EU');
CREATE TYPE "InventoryAllocationPolicyLifecycle" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

ALTER TABLE "Warehouse" ADD COLUMN "fulfillmentRegion" "FulfillmentRegion";

UPDATE "Warehouse"
SET "fulfillmentRegion" = CASE
  WHEN "countryCode" = 'US' THEN 'US'::"FulfillmentRegion"
  WHEN "countryCode" = 'MA' THEN 'MOROCCO'::"FulfillmentRegion"
  ELSE 'EU'::"FulfillmentRegion"
END;

ALTER TABLE "Warehouse" ALTER COLUMN "fulfillmentRegion" SET NOT NULL;

CREATE TABLE "InventoryAllocationPolicy" (
  "id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "destinationRegion" "FulfillmentRegion" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryAllocationPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryAllocationPolicy_code_check" CHECK (
    "code" ~ '^[A-Z][A-Z0-9_-]{2,63}$'
  )
);

CREATE TABLE "InventoryAllocationPolicyVersion" (
  "id" UUID NOT NULL,
  "policyId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "lifecycle" "InventoryAllocationPolicyLifecycle" NOT NULL DEFAULT 'DRAFT',
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryAllocationPolicyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryAllocationPolicyVersion_metadata_check" CHECK (
    "version" > 0
    AND (
      ("lifecycle" = 'DRAFT' AND "activatedAt" IS NULL AND "retiredAt" IS NULL)
      OR
      ("lifecycle" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL)
      OR
      (
        "lifecycle" = 'RETIRED'
        AND "activatedAt" IS NOT NULL
        AND "retiredAt" IS NOT NULL
        AND "retiredAt" >= "activatedAt"
      )
    )
  )
);

CREATE TABLE "InventoryAllocationPolicyWarehouse" (
  "policyVersionId" UUID NOT NULL,
  "warehouseId" UUID NOT NULL,
  "priority" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryAllocationPolicyWarehouse_pkey" PRIMARY KEY ("policyVersionId", "warehouseId"),
  CONSTRAINT "InventoryAllocationPolicyWarehouse_priority_check" CHECK ("priority" > 0)
);

CREATE UNIQUE INDEX "InventoryAllocationPolicy_code_key"
  ON "InventoryAllocationPolicy"("code");
CREATE UNIQUE INDEX "InventoryAllocationPolicyVersion_policyId_version_key"
  ON "InventoryAllocationPolicyVersion"("policyId", "version");
CREATE INDEX "InventoryAllocationPolicyVersion_policyId_lifecycle_idx"
  ON "InventoryAllocationPolicyVersion"("policyId", "lifecycle");
CREATE UNIQUE INDEX "InventoryAllocationPolicyVersion_one_active_per_policy"
  ON "InventoryAllocationPolicyVersion"("policyId")
  WHERE "lifecycle" = 'ACTIVE';
CREATE UNIQUE INDEX "InventoryAllocationPolicyWarehouse_policyVersionId_priority_key"
  ON "InventoryAllocationPolicyWarehouse"("policyVersionId", "priority");
CREATE INDEX "InventoryAllocationPolicyWarehouse_warehouseId_policyVersionId_idx"
  ON "InventoryAllocationPolicyWarehouse"("warehouseId", "policyVersionId");
CREATE INDEX "Warehouse_status_fulfillmentRegion_code_idx"
  ON "Warehouse"("status", "fulfillmentRegion", "code");

ALTER TABLE "InventoryAllocationPolicyVersion"
  ADD CONSTRAINT "InventoryAllocationPolicyVersion_policyId_fkey"
  FOREIGN KEY ("policyId") REFERENCES "InventoryAllocationPolicy"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryAllocationPolicyWarehouse"
  ADD CONSTRAINT "InventoryAllocationPolicyWarehouse_policyVersionId_fkey"
  FOREIGN KEY ("policyVersionId") REFERENCES "InventoryAllocationPolicyVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryAllocationPolicyWarehouse"
  ADD CONSTRAINT "InventoryAllocationPolicyWarehouse_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "InventoryReservationItem_reservationId_variantId_key";
CREATE UNIQUE INDEX "InventoryReservationItem_reservationId_warehouseId_variantId_key"
  ON "InventoryReservationItem"("reservationId", "warehouseId", "variantId");

CREATE OR REPLACE FUNCTION reject_distributed_inventory_history_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% history cannot be deleted', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION protect_warehouse_fulfillment_region()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."fulfillmentRegion" IS DISTINCT FROM OLD."fulfillmentRegion" THEN
    RAISE EXCEPTION 'warehouse fulfillment region is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Warehouse_fulfillment_region_immutable"
BEFORE UPDATE ON "Warehouse"
FOR EACH ROW EXECUTE FUNCTION protect_warehouse_fulfillment_region();

CREATE OR REPLACE FUNCTION protect_inventory_allocation_policy_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."destinationRegion" IS DISTINCT FROM OLD."destinationRegion"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'inventory allocation policy identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "InventoryAllocationPolicy_identity_immutable"
BEFORE UPDATE ON "InventoryAllocationPolicy"
FOR EACH ROW EXECUTE FUNCTION protect_inventory_allocation_policy_identity();

CREATE OR REPLACE FUNCTION require_inventory_allocation_policy_version_draft()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."lifecycle" IS DISTINCT FROM 'DRAFT'::"InventoryAllocationPolicyLifecycle"
    OR NEW."activatedAt" IS NOT NULL
    OR NEW."retiredAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'inventory allocation policy versions must be created as drafts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "InventoryAllocationPolicyVersion_draft_on_insert"
BEFORE INSERT ON "InventoryAllocationPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION require_inventory_allocation_policy_version_draft();

CREATE OR REPLACE FUNCTION validate_inventory_allocation_policy_version_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  assignment_count INTEGER;
  minimum_priority INTEGER;
  maximum_priority INTEGER;
  preferred_region "FulfillmentRegion";
  destination_region "FulfillmentRegion";
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."policyId" IS DISTINCT FROM OLD."policyId"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR (
      NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
      AND NOT (OLD."lifecycle" = 'DRAFT' AND NEW."lifecycle" = 'ACTIVE')
    )
  THEN
    RAISE EXCEPTION 'inventory allocation policy version identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."lifecycle" = 'DRAFT' AND NEW."lifecycle" = 'ACTIVE' THEN
    IF NEW."activatedAt" IS NULL OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'active allocation policy metadata is invalid' USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*), MIN(assignment."priority"), MAX(assignment."priority")
    INTO assignment_count, minimum_priority, maximum_priority
    FROM "InventoryAllocationPolicyWarehouse" AS assignment
    WHERE assignment."policyVersionId" = NEW."id";

    IF assignment_count = 0 OR minimum_priority <> 1 OR maximum_priority <> assignment_count THEN
      RAISE EXCEPTION 'allocation policy priorities must be contiguous from one'
        USING ERRCODE = '23514';
    END IF;

    SELECT policy."destinationRegion", warehouse."fulfillmentRegion"
    INTO destination_region, preferred_region
    FROM "InventoryAllocationPolicy" AS policy
    JOIN "InventoryAllocationPolicyWarehouse" AS assignment
      ON assignment."policyVersionId" = NEW."id" AND assignment."priority" = 1
    JOIN "Warehouse" AS warehouse ON warehouse."id" = assignment."warehouseId"
    WHERE policy."id" = NEW."policyId";

    IF preferred_region IS DISTINCT FROM destination_region THEN
      RAISE EXCEPTION 'allocation policy priority one must match its destination region'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD."lifecycle" = 'ACTIVE' AND NEW."lifecycle" = 'RETIRED' THEN
    IF NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
      OR NEW."retiredAt" IS NULL
      OR NEW."retiredAt" < OLD."activatedAt"
    THEN
      RAISE EXCEPTION 'retired allocation policy metadata is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."lifecycle" IS DISTINCT FROM OLD."lifecycle"
    OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
    OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt"
  THEN
    RAISE EXCEPTION 'invalid inventory allocation policy lifecycle transition'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "InventoryAllocationPolicyVersion_valid_transition"
BEFORE UPDATE ON "InventoryAllocationPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION validate_inventory_allocation_policy_version_transition();

CREATE OR REPLACE FUNCTION protect_inventory_allocation_policy_warehouse()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owning_version_id UUID;
  owning_lifecycle "InventoryAllocationPolicyLifecycle";
BEGIN
  owning_version_id := COALESCE(NEW."policyVersionId", OLD."policyVersionId");

  SELECT version."lifecycle"
  INTO owning_lifecycle
  FROM "InventoryAllocationPolicyVersion" AS version
  WHERE version."id" = owning_version_id;

  IF owning_lifecycle IS DISTINCT FROM 'DRAFT'::"InventoryAllocationPolicyLifecycle" THEN
    RAISE EXCEPTION 'active or retired allocation policy assignments are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."policyVersionId" IS DISTINCT FROM OLD."policyVersionId" THEN
    RAISE EXCEPTION 'allocation policy assignment ownership is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'allocation policy assignment creation time is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "InventoryAllocationPolicyWarehouse_draft_only_insert"
BEFORE INSERT ON "InventoryAllocationPolicyWarehouse"
FOR EACH ROW EXECUTE FUNCTION protect_inventory_allocation_policy_warehouse();

CREATE TRIGGER "InventoryAllocationPolicyWarehouse_draft_only_update"
BEFORE UPDATE ON "InventoryAllocationPolicyWarehouse"
FOR EACH ROW EXECUTE FUNCTION protect_inventory_allocation_policy_warehouse();

CREATE TRIGGER "InventoryAllocationPolicyWarehouse_draft_only_delete"
BEFORE DELETE ON "InventoryAllocationPolicyWarehouse"
FOR EACH ROW EXECUTE FUNCTION protect_inventory_allocation_policy_warehouse();

CREATE TRIGGER "InventoryAllocationPolicy_retain"
BEFORE DELETE ON "InventoryAllocationPolicy"
FOR EACH ROW EXECUTE FUNCTION reject_distributed_inventory_history_delete();

CREATE TRIGGER "InventoryAllocationPolicyVersion_retain"
BEFORE DELETE ON "InventoryAllocationPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION reject_distributed_inventory_history_delete();
