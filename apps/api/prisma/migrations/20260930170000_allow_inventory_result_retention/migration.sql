-- Allow retention's cascading idempotency delete while preserving direct snapshot immutability.
CREATE OR REPLACE FUNCTION pulsefield_inventory_command_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'inventory command result is retention-managed';
  END IF;
  RAISE EXCEPTION 'inventory command result is immutable';
END;
$$;
