-- Phase 3 Slice 3.5 forward hardening: persist immutable fulfillment command
-- responses so idempotent replays return the original transition snapshot.

CREATE TABLE "FulfillmentTransitionResult" (
  "id" UUID NOT NULL,
  "idempotencyRecordId" UUID NOT NULL,
  "fulfillmentGroupId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "warehouseId" UUID NOT NULL,
  "status" "FulfillmentGroupStatus" NOT NULL,
  "version" INTEGER NOT NULL,
  "pickingStartedAt" TIMESTAMP(3),
  "packedAt" TIMESTAMP(3),
  "shippedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "carrierCode" VARCHAR(32),
  "trackingReference" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FulfillmentTransitionResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FulfillmentTransitionResult_version_check" CHECK ("version" > 0),
  CONSTRAINT "FulfillmentTransitionResult_tracking_format_check" CHECK (
    ("carrierCode" IS NULL OR "carrierCode" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$')
    AND ("trackingReference" IS NULL OR "trackingReference" ~ '^[A-Z0-9][A-Z0-9._-]{5,63}$')
  )
);

CREATE UNIQUE INDEX "FulfillmentTransitionResult_idempotencyRecordId_key"
  ON "FulfillmentTransitionResult"("idempotencyRecordId");
CREATE INDEX "FulfillmentTransitionResult_fulfillmentGroupId_version_idx"
  ON "FulfillmentTransitionResult"("fulfillmentGroupId", "version");

ALTER TABLE "FulfillmentTransitionResult"
  ADD CONSTRAINT "FulfillmentTransitionResult_idempotencyRecordId_fkey"
  FOREIGN KEY ("idempotencyRecordId") REFERENCES "IdempotencyRecord"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FulfillmentTransitionResult"
  ADD CONSTRAINT "FulfillmentTransitionResult_fulfillmentGroupId_fkey"
  FOREIGN KEY ("fulfillmentGroupId") REFERENCES "FulfillmentGroup"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "reject_fulfillment_transition_result_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fulfillment transition results are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FulfillmentTransitionResult_append_only"
  BEFORE UPDATE OR DELETE ON "FulfillmentTransitionResult"
  FOR EACH ROW EXECUTE FUNCTION "reject_fulfillment_transition_result_mutation"();
