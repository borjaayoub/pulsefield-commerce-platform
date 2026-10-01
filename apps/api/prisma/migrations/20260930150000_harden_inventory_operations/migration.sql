-- Forward hardening for the already-applied inventory operations migration.
-- Movement coverage is checked at transaction commit for every transfer line.

CREATE UNIQUE INDEX IF NOT EXISTS "InventoryMovement_transferLineId_type_key"
  ON "InventoryMovement" ("transferLineId", "type")
  WHERE "transferLineId" IS NOT NULL;

CREATE OR REPLACE FUNCTION pulsefield_transfer_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' OR NEW."version" <> 1 OR NEW."dispatchedAt" IS NOT NULL OR NEW."receivedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN RAISE EXCEPTION 'invalid transfer initial state'; END IF;
  ELSE
    IF NEW."sourceWarehouseId" IS DISTINCT FROM OLD."sourceWarehouseId" OR NEW."destinationWarehouseId" IS DISTINCT FROM OLD."destinationWarehouseId" OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy" OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'transfer identity is immutable'; END IF;
    IF NEW."version" <> OLD."version" + 1 THEN RAISE EXCEPTION 'transfer version must increment exactly once'; END IF;
    IF OLD."status" = 'REQUESTED' AND NEW."status" NOT IN ('IN_TRANSIT','CANCELLED') THEN RAISE EXCEPTION 'invalid requested transition'; END IF;
    IF OLD."status" = 'IN_TRANSIT' AND NEW."status" <> 'RECEIVED' THEN RAISE EXCEPTION 'invalid in-transit transition'; END IF;
    IF OLD."status" IN ('RECEIVED','CANCELLED') THEN RAISE EXCEPTION 'terminal transfer is immutable'; END IF;
    IF NEW."status" = 'IN_TRANSIT' AND (NEW."dispatchedAt" IS NULL OR NEW."receivedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL) THEN RAISE EXCEPTION 'invalid dispatch timestamps'; END IF;
    IF NEW."status" = 'RECEIVED' AND (NEW."dispatchedAt" IS NULL OR NEW."receivedAt" IS NULL OR NEW."receivedAt" < NEW."dispatchedAt" OR NEW."cancelledAt" IS NOT NULL) THEN RAISE EXCEPTION 'invalid receipt timestamps'; END IF;
    IF NEW."status" = 'CANCELLED' AND (NEW."cancelledAt" IS NULL OR NEW."dispatchedAt" IS NOT NULL OR NEW."receivedAt" IS NOT NULL) THEN RAISE EXCEPTION 'invalid cancellation timestamps'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS inventory_transfer_header_guard ON "InventoryTransfer";
CREATE TRIGGER inventory_transfer_header_guard BEFORE INSERT OR UPDATE ON "InventoryTransfer" FOR EACH ROW EXECUTE FUNCTION pulsefield_transfer_header_guard();

CREATE OR REPLACE FUNCTION pulsefield_transfer_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer_status "InventoryTransferStatus";
BEGIN
  SELECT "status" INTO transfer_status FROM "InventoryTransfer" WHERE "id" = COALESCE(NEW."transferId", OLD."transferId");
  IF transfer_status <> 'REQUESTED' AND TG_OP IN ('INSERT','DELETE') THEN RAISE EXCEPTION 'transfer lines are immutable after dispatch'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW."transferId" IS DISTINCT FROM OLD."transferId" OR NEW."variantId" IS DISTINCT FROM OLD."variantId" OR NEW."quantity" IS DISTINCT FROM OLD."quantity") THEN RAISE EXCEPTION 'transfer line identity is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND transfer_status <> 'IN_TRANSIT' AND (NEW."received" IS DISTINCT FROM OLD."received" OR NEW."damaged" IS DISTINCT FROM OLD."damaged" OR NEW."lost" IS DISTINCT FROM OLD."lost") THEN RAISE EXCEPTION 'receipt can only be recorded in transit'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."received" IS NOT NULL AND (NEW."received" IS DISTINCT FROM OLD."received" OR NEW."damaged" IS DISTINCT FROM OLD."damaged" OR NEW."lost" IS DISTINCT FROM OLD."lost") THEN RAISE EXCEPTION 'receipt is immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS inventory_transfer_line_guard ON "InventoryTransferLine";
CREATE TRIGGER inventory_transfer_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "InventoryTransferLine" FOR EACH ROW EXECUTE FUNCTION pulsefield_transfer_line_guard();

CREATE OR REPLACE FUNCTION pulsefield_transfer_line_count_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count INTEGER; transfer_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'InventoryTransfer' THEN transfer_id := COALESCE(NEW."id", OLD."id"); ELSE transfer_id := COALESCE(NEW."transferId", OLD."transferId"); END IF;
  SELECT count(*) INTO line_count FROM "InventoryTransferLine" WHERE "transferId" = transfer_id;
  IF line_count < 1 OR line_count > 50 THEN RAISE EXCEPTION 'transfer requires one to fifty lines'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS inventory_transfer_line_count_guard ON "InventoryTransferLine";
CREATE CONSTRAINT TRIGGER inventory_transfer_line_count_guard AFTER INSERT OR UPDATE OR DELETE ON "InventoryTransferLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pulsefield_transfer_line_count_guard();
CREATE CONSTRAINT TRIGGER inventory_transfer_header_count_guard AFTER INSERT OR UPDATE ON "InventoryTransfer" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pulsefield_transfer_line_count_guard();

CREATE OR REPLACE FUNCTION pulsefield_transfer_movement_coverage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line RECORD; transfer_status "InventoryTransferStatus"; dispatch_count INTEGER; receipt_count INTEGER; damage_count INTEGER; received_qty INTEGER; damaged_qty INTEGER; lost_qty INTEGER;
BEGIN
  SELECT l.*, t."status" INTO line FROM "InventoryTransferLine" l JOIN "InventoryTransfer" t ON t."id" = l."transferId" WHERE l."id" = COALESCE(NEW."transferLineId", OLD."id");
  IF line."id" IS NULL THEN RETURN NULL; END IF;
  transfer_status := line."status";
  SELECT count(*) FILTER (WHERE type = 'TRANSFER_DISPATCH'), count(*) FILTER (WHERE type = 'TRANSFER_RECEIPT'), count(*) FILTER (WHERE type = 'TRANSFER_DAMAGE'), COALESCE(sum(onHandDelta) FILTER (WHERE type = 'TRANSFER_RECEIPT'),0), COALESCE(sum(damagedDelta) FILTER (WHERE type = 'TRANSFER_DAMAGE'),0) INTO dispatch_count, receipt_count, damage_count, received_qty, damaged_qty FROM "InventoryMovement" WHERE "transferLineId" = line."id" AND "commandId" = line."transferId";
  IF transfer_status = 'REQUESTED' OR transfer_status = 'CANCELLED' THEN IF dispatch_count <> 0 OR receipt_count <> 0 OR damage_count <> 0 THEN RAISE EXCEPTION 'unexpected transfer movement before dispatch'; END IF; END IF;
  IF transfer_status IN ('IN_TRANSIT','RECEIVED') AND dispatch_count <> 1 THEN RAISE EXCEPTION 'transfer dispatch coverage mismatch'; END IF;
  IF transfer_status = 'IN_TRANSIT' AND (receipt_count <> 0 OR damage_count <> 0) THEN RAISE EXCEPTION 'unexpected transfer receipt'; END IF;
  IF transfer_status = 'RECEIVED' AND (received_qty <> COALESCE(line."received",0) OR damaged_qty <> COALESCE(line."damaged",0) OR receipt_count <> CASE WHEN COALESCE(line."received",0) > 0 THEN 1 ELSE 0 END OR damage_count <> CASE WHEN COALESCE(line."damaged",0) > 0 THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'transfer receipt coverage mismatch'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_transfer_movement_coverage AFTER INSERT OR UPDATE OR DELETE ON "InventoryMovement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pulsefield_transfer_movement_coverage_guard();
CREATE CONSTRAINT TRIGGER inventory_transfer_line_movement_coverage AFTER INSERT OR UPDATE ON "InventoryTransferLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pulsefield_transfer_movement_coverage_guard();
