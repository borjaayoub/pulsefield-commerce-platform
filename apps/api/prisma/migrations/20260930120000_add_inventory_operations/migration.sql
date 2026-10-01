ALTER TYPE "InventoryMovementType" ADD VALUE IF NOT EXISTS 'TRANSFER_DISPATCH';
ALTER TYPE "InventoryMovementType" ADD VALUE IF NOT EXISTS 'TRANSFER_RECEIPT';
ALTER TYPE "InventoryMovementType" ADD VALUE IF NOT EXISTS 'TRANSFER_DAMAGE';
ALTER TABLE "InventoryMovement" DROP CONSTRAINT IF EXISTS "InventoryMovement_type_semantics_check";
ALTER TABLE "InventoryMovement" DROP CONSTRAINT IF EXISTS "InventoryMovement_content_check";
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_content_check" CHECK ("commandSequence" > 0 AND length(btrim("actorId")) > 0 AND length(btrim("reason")) > 0 AND ("onHandDelta" <> 0 OR "reservedDelta" <> 0 OR "allocatedDelta" <> 0 OR "damagedDelta" <> 0));
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_type_semantics_check" CHECK (
 ("type" = 'INITIAL_STOCK' AND "onHandDelta" > 0 AND "reservedDelta" = 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
 OR ("type" = 'ADJUSTMENT')
 OR ("type" = 'RESERVED' AND "onHandDelta" = 0 AND "reservedDelta" > 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
 OR ("type" IN ('RESERVATION_RELEASED','RESERVATION_EXPIRED') AND "onHandDelta" = 0 AND "reservedDelta" < 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
 OR ("type" = 'RESERVATION_COMMITTED' AND "onHandDelta" = 0 AND "reservedDelta" < 0 AND "allocatedDelta" = -"reservedDelta" AND "damagedDelta" = 0)
 OR ("type" = 'FULFILLMENT_DECREMENT' AND "onHandDelta" < 0 AND "reservedDelta" = 0 AND "allocatedDelta" = "onHandDelta" AND "damagedDelta" = 0)
 OR ("type" = 'TRANSFER_DISPATCH' AND "onHandDelta" < 0 AND "reservedDelta" = 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
 OR ("type" = 'TRANSFER_RECEIPT' AND "onHandDelta" > 0 AND "reservedDelta" = 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
 OR ("type" = 'TRANSFER_DAMAGE' AND "onHandDelta" > 0 AND "reservedDelta" = 0 AND "allocatedDelta" = 0 AND "damagedDelta" > 0)
);
CREATE TYPE "InventoryTransferStatus" AS ENUM ('REQUESTED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');
ALTER TABLE "InventoryBalance" ADD COLUMN "lowStockThreshold" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InventoryMovement" ADD COLUMN "transferLineId" UUID;
CREATE TABLE "InventoryTransfer" ("id" UUID NOT NULL, "sourceWarehouseId" UUID NOT NULL, "destinationWarehouseId" UUID NOT NULL, "status" "InventoryTransferStatus" NOT NULL DEFAULT 'REQUESTED', "version" INTEGER NOT NULL DEFAULT 1, "reason" VARCHAR(500) NOT NULL, "createdBy" VARCHAR(128) NOT NULL, "dispatchedAt" TIMESTAMP(3), "receivedAt" TIMESTAMP(3), "cancelledAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "InventoryTransfer_pkey" PRIMARY KEY ("id"), CONSTRAINT "InventoryTransfer_sourceWarehouseId_fkey" FOREIGN KEY ("sourceWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "InventoryTransfer_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "InventoryTransfer_distinct_warehouses" CHECK ("sourceWarehouseId" <> "destinationWarehouseId"), CONSTRAINT "InventoryTransfer_version_positive" CHECK ("version" > 0));
CREATE INDEX "InventoryTransfer_status_createdAt_id_idx" ON "InventoryTransfer"("status", "createdAt", "id");
CREATE TABLE "InventoryTransferLine" ("id" UUID NOT NULL, "transferId" UUID NOT NULL, "variantId" UUID NOT NULL, "quantity" INTEGER NOT NULL, "received" INTEGER, "damaged" INTEGER, "lost" INTEGER, CONSTRAINT "InventoryTransferLine_pkey" PRIMARY KEY ("id"), CONSTRAINT "InventoryTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "InventoryTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "InventoryTransferLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "InventoryTransferLine_quantity_positive" CHECK ("quantity" > 0), CONSTRAINT "InventoryTransferLine_receipt_bounds" CHECK (("received" IS NULL AND "damaged" IS NULL AND "lost" IS NULL) OR ("received" IS NOT NULL AND "damaged" IS NOT NULL AND "lost" IS NOT NULL AND "received" >= 0 AND "damaged" >= 0 AND "lost" >= 0 AND "received" + "damaged" + "lost" = "quantity")));
CREATE UNIQUE INDEX "InventoryTransferLine_transferId_variantId_key" ON "InventoryTransferLine"("transferId", "variantId");
CREATE TABLE "InventoryCommandResult" ("id" UUID NOT NULL, "idempotencyRecordId" UUID NOT NULL, "transferId" UUID, "resultType" VARCHAR(128) NOT NULL, "resourceId" VARCHAR(128) NOT NULL, "responseStatus" INTEGER NOT NULL, "version" INTEGER NOT NULL, "etag" VARCHAR(128) NOT NULL, "snapshot" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "InventoryCommandResult_pkey" PRIMARY KEY ("id"), CONSTRAINT "InventoryCommandResult_idempotencyRecordId_fkey" FOREIGN KEY ("idempotencyRecordId") REFERENCES "IdempotencyRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "InventoryCommandResult_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "InventoryTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE);
CREATE UNIQUE INDEX "InventoryCommandResult_idempotencyRecordId_key" ON "InventoryCommandResult"("idempotencyRecordId");
CREATE INDEX "InventoryCommandResult_transferId_createdAt_idx" ON "InventoryCommandResult"("transferId", "createdAt");
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_transferLineId_fkey" FOREIGN KEY ("transferLineId") REFERENCES "InventoryTransferLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_lowStockThreshold_nonnegative" CHECK ("lowStockThreshold" >= 0);

CREATE OR REPLACE FUNCTION pulsefield_inventory_transfer_guards() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."status" <> OLD."status") AND NOT ((OLD."status" = 'REQUESTED' AND NEW."status" IN ('IN_TRANSIT','CANCELLED')) OR (OLD."status" = 'IN_TRANSIT' AND NEW."status" = 'RECEIVED')) THEN
    RAISE EXCEPTION 'invalid inventory transfer lifecycle';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('RECEIVED','CANCELLED') AND (NEW."status" <> OLD."status" OR NEW."version" <> OLD."version") THEN
    RAISE EXCEPTION 'terminal inventory transfer is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_transfer_lifecycle_guard BEFORE UPDATE ON "InventoryTransfer" FOR EACH ROW EXECUTE FUNCTION pulsefield_inventory_transfer_guards();

CREATE OR REPLACE FUNCTION pulsefield_inventory_transfer_line_guards() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."transferId" = NEW."transferId" AND OLD."variantId" = NEW."variantId" AND OLD."quantity" = NEW."quantity" THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'inventory transfer line identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_transfer_line_identity_guard BEFORE UPDATE ON "InventoryTransferLine" FOR EACH ROW EXECUTE FUNCTION pulsefield_inventory_transfer_line_guards();

CREATE OR REPLACE FUNCTION pulsefield_inventory_movement_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."type" IN ('TRANSFER_DISPATCH','TRANSFER_RECEIPT','TRANSFER_DAMAGE') AND NEW."transferLineId" IS NULL THEN
    RAISE EXCEPTION 'transfer movement requires a transfer line';
  END IF;
  IF NEW."type" NOT IN ('TRANSFER_DISPATCH','TRANSFER_RECEIPT','TRANSFER_DAMAGE') AND NEW."transferLineId" IS NOT NULL THEN
    RAISE EXCEPTION 'non-transfer movement cannot reference a transfer line';
  END IF;
  IF NEW."transferLineId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "InventoryTransferLine" line JOIN "InventoryTransfer" transfer ON transfer."id" = line."transferId"
    WHERE line."id" = NEW."transferLineId" AND line."variantId" = NEW."variantId"
      AND ((NEW."type" = 'TRANSFER_DISPATCH' AND transfer."sourceWarehouseId" = NEW."warehouseId")
        OR (NEW."type" IN ('TRANSFER_RECEIPT','TRANSFER_DAMAGE') AND transfer."destinationWarehouseId" = NEW."warehouseId"))
  ) THEN RAISE EXCEPTION 'transfer movement does not match transfer line'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_movement_transfer_guard BEFORE INSERT ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION pulsefield_inventory_movement_transfer_guard();

CREATE OR REPLACE FUNCTION pulsefield_inventory_command_result_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'inventory command result is immutable'; END $$;
CREATE TRIGGER inventory_command_result_immutable BEFORE UPDATE ON "InventoryCommandResult" FOR EACH ROW EXECUTE FUNCTION pulsefield_inventory_command_result_immutable();

CREATE OR REPLACE FUNCTION pulsefield_inventory_transfer_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'REQUESTED' OR NEW."version" <> 1 OR NEW."dispatchedAt" IS NOT NULL OR NEW."receivedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN RAISE EXCEPTION 'inventory transfer must begin requested'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_transfer_insert_guard BEFORE INSERT ON "InventoryTransfer" FOR EACH ROW EXECUTE FUNCTION pulsefield_inventory_transfer_insert_guard();

CREATE OR REPLACE FUNCTION pulsefield_inventory_transfer_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sourceWarehouseId" IS DISTINCT FROM OLD."sourceWarehouseId" OR NEW."destinationWarehouseId" IS DISTINCT FROM OLD."destinationWarehouseId" OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy" OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'inventory transfer identity is immutable'; END IF;
  IF NEW."version" <> OLD."version" + 1 THEN RAISE EXCEPTION 'inventory transfer version must increment once'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_transfer_update_guard BEFORE UPDATE ON "InventoryTransfer" FOR EACH ROW EXECUTE FUNCTION pulsefield_inventory_transfer_update_guard();

CREATE OR REPLACE FUNCTION pulsefield_inventory_transfer_line_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer_status "InventoryTransferStatus";
BEGIN
  SELECT "status" INTO transfer_status FROM "InventoryTransfer" WHERE "id" = NEW."transferId";
  IF TG_OP = 'UPDATE' AND (OLD."transferId" IS DISTINCT FROM NEW."transferId" OR OLD."variantId" IS DISTINCT FROM NEW."variantId" OR OLD."quantity" IS DISTINCT FROM NEW."quantity") THEN RAISE EXCEPTION 'inventory transfer line identity is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."received" IS NOT NULL AND (NEW."received" IS DISTINCT FROM OLD."received" OR NEW."damaged" IS DISTINCT FROM OLD."damaged" OR NEW."lost" IS DISTINCT FROM OLD."lost") THEN RAISE EXCEPTION 'inventory receipt is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."received" IS NULL AND (NEW."received" IS NOT NULL OR NEW."damaged" IS NOT NULL OR NEW."lost" IS NOT NULL) AND transfer_status <> 'IN_TRANSIT' THEN RAISE EXCEPTION 'receipt requires in-transit transfer'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_transfer_line_receipt_guard BEFORE UPDATE ON "InventoryTransferLine" FOR EACH ROW EXECUTE FUNCTION pulsefield_inventory_transfer_line_receipt_guard();

CREATE OR REPLACE FUNCTION pulsefield_inventory_transfer_line_count_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count INTEGER;
BEGIN
  SELECT count(*) INTO line_count FROM "InventoryTransferLine" WHERE "transferId" = COALESCE(NEW."transferId", OLD."transferId");
  IF line_count < 1 OR line_count > 50 THEN RAISE EXCEPTION 'inventory transfer requires one to fifty lines'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_transfer_line_count_guard AFTER INSERT OR UPDATE OR DELETE ON "InventoryTransferLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pulsefield_inventory_transfer_line_count_guard();
