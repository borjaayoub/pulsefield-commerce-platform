-- Permit only the FK cascade issued after its idempotency parent is removed.
CREATE OR REPLACE FUNCTION pulsefield_inventory_command_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "IdempotencyRecord" WHERE "id" = OLD."idempotencyRecordId") THEN
      RAISE EXCEPTION 'inventory command result is retention-managed';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'inventory command result is immutable';
END;
$$;
