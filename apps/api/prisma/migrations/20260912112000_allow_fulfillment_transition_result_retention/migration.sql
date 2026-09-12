-- Fulfillment transition snapshots are immutable replay artifacts, but they
-- are retention-scoped and must be removable with their idempotency record.
DROP TRIGGER IF EXISTS "FulfillmentTransitionResult_append_only"
  ON "FulfillmentTransitionResult";

CREATE OR REPLACE FUNCTION "reject_fulfillment_transition_result_update"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fulfillment transition results are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FulfillmentTransitionResult_immutable"
  BEFORE UPDATE ON "FulfillmentTransitionResult"
  FOR EACH ROW EXECUTE FUNCTION "reject_fulfillment_transition_result_update"();
