-- Repair the deferred transfer coverage guard without editing applied migrations.

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
    IF NEW."status" = 'IN_TRANSIT' AND (NEW."dispatchedAt" IS NULL OR NEW."dispatchedAt" < NEW."createdAt" OR NEW."receivedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL) THEN RAISE EXCEPTION 'invalid dispatch timestamps'; END IF;
    IF NEW."status" = 'RECEIVED' AND (NEW."dispatchedAt" IS NULL OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt" OR NEW."receivedAt" IS NULL OR NEW."receivedAt" < NEW."dispatchedAt" OR NEW."cancelledAt" IS NOT NULL) THEN RAISE EXCEPTION 'invalid receipt timestamps'; END IF;
    IF NEW."status" = 'CANCELLED' AND (NEW."cancelledAt" IS NULL OR NEW."cancelledAt" < NEW."createdAt" OR NEW."dispatchedAt" IS NOT NULL OR NEW."receivedAt" IS NOT NULL) THEN RAISE EXCEPTION 'invalid cancellation timestamps'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pulsefield_transfer_coverage_for(p_transfer_id UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE line RECORD; total INTEGER; dispatch_count INTEGER; dispatch_sum INTEGER; receipt_count INTEGER; receipt_sum INTEGER; damage_count INTEGER; damage_sum INTEGER; damage_on_hand INTEGER; wrong_command INTEGER; transfer_status "InventoryTransferStatus";
BEGIN
  SELECT "status" INTO transfer_status FROM "InventoryTransfer" WHERE "id" = p_transfer_id;
  IF transfer_status IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO total FROM "InventoryTransferLine" WHERE "transferId" = p_transfer_id;
  IF total < 1 OR total > 50 THEN RAISE EXCEPTION 'transfer requires one to fifty lines'; END IF;
  FOR line IN SELECT * FROM "InventoryTransferLine" WHERE "transferId" = p_transfer_id LOOP
    SELECT count(*) FILTER (WHERE "type" = 'TRANSFER_DISPATCH'), COALESCE(sum("onHandDelta") FILTER (WHERE "type" = 'TRANSFER_DISPATCH'),0), count(*) FILTER (WHERE "type" = 'TRANSFER_RECEIPT'), COALESCE(sum("onHandDelta") FILTER (WHERE "type" = 'TRANSFER_RECEIPT'),0), count(*) FILTER (WHERE "type" = 'TRANSFER_DAMAGE'), COALESCE(sum("onHandDelta") FILTER (WHERE "type" = 'TRANSFER_DAMAGE'),0), COALESCE(sum("damagedDelta") FILTER (WHERE "type" = 'TRANSFER_DAMAGE'),0), count(*) FILTER (WHERE "commandId" <> p_transfer_id) INTO dispatch_count, dispatch_sum, receipt_count, receipt_sum, damage_count, damage_sum, damage_on_hand, wrong_command FROM "InventoryMovement" WHERE "transferLineId" = line."id";
    IF wrong_command <> 0 THEN RAISE EXCEPTION 'transfer movement command mismatch'; END IF;
    IF transfer_status IN ('REQUESTED','CANCELLED') THEN
      IF dispatch_count <> 0 OR receipt_count <> 0 OR damage_count <> 0 OR line."received" IS NOT NULL OR line."damaged" IS NOT NULL OR line."lost" IS NOT NULL THEN RAISE EXCEPTION 'unexpected transfer movement or receipt'; END IF;
    ELSIF transfer_status = 'IN_TRANSIT' THEN
      IF dispatch_count <> 1 OR dispatch_sum <> -line."quantity" OR receipt_count <> 0 OR damage_count <> 0 OR line."received" IS NOT NULL OR line."damaged" IS NOT NULL OR line."lost" IS NOT NULL THEN RAISE EXCEPTION 'dispatch coverage mismatch'; END IF;
    ELSIF transfer_status = 'RECEIVED' THEN
      IF line."received" IS NULL OR line."damaged" IS NULL OR line."lost" IS NULL OR line."received" + line."damaged" + line."lost" <> line."quantity" THEN RAISE EXCEPTION 'receipt conservation mismatch'; END IF;
      IF dispatch_count <> 1 OR dispatch_sum <> -line."quantity" OR receipt_sum <> line."received" OR damage_sum <> line."damaged" OR damage_on_hand <> line."damaged" OR receipt_count <> (CASE WHEN line."received" > 0 THEN 1 ELSE 0 END) OR damage_count <> (CASE WHEN line."damaged" > 0 THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'receipt movement coverage mismatch'; END IF;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION pulsefield_transfer_coverage_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'InventoryTransfer' THEN transfer_id := COALESCE(NEW."id", OLD."id");
  ELSIF TG_TABLE_NAME = 'InventoryTransferLine' THEN transfer_id := COALESCE(NEW."transferId", OLD."transferId");
  ELSE SELECT "transferId" INTO transfer_id FROM "InventoryTransferLine" WHERE "id" = COALESCE(NEW."transferLineId", OLD."transferLineId"); END IF;
  PERFORM pulsefield_transfer_coverage_for(transfer_id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS inventory_transfer_movement_coverage ON "InventoryMovement";
DROP TRIGGER IF EXISTS inventory_transfer_line_movement_coverage ON "InventoryTransferLine";
DROP TRIGGER IF EXISTS inventory_transfer_header_movement_coverage ON "InventoryTransfer";
CREATE CONSTRAINT TRIGGER inventory_transfer_movement_coverage AFTER INSERT OR UPDATE OR DELETE ON "InventoryMovement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pulsefield_transfer_coverage_trigger();
CREATE CONSTRAINT TRIGGER inventory_transfer_line_movement_coverage AFTER INSERT OR UPDATE OR DELETE ON "InventoryTransferLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pulsefield_transfer_coverage_trigger();
CREATE CONSTRAINT TRIGGER inventory_transfer_header_movement_coverage AFTER INSERT OR UPDATE ON "InventoryTransfer" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pulsefield_transfer_coverage_trigger();

CREATE OR REPLACE FUNCTION pulsefield_inventory_command_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 THEN RAISE EXCEPTION 'inventory command result is retention-managed'; END IF;
  RAISE EXCEPTION 'inventory command result is immutable';
END $$;
DROP TRIGGER IF EXISTS inventory_command_result_immutable ON "InventoryCommandResult";
CREATE TRIGGER inventory_command_result_immutable BEFORE UPDATE OR DELETE ON "InventoryCommandResult" FOR EACH ROW EXECUTE FUNCTION pulsefield_inventory_command_result_guard();
