-- Phase 4 Slice 4.4a: provider-neutral late-success compensation foundation.
-- This migration executes no refund and introduces no provider network call.

CREATE TYPE "PaymentCompensationReason" AS ENUM (
  'LATE_SUCCESS_STOCK_UNAVAILABLE'
);

CREATE TYPE "PaymentCompensationStatus" AS ENUM (
  'REQUIRED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED'
);

CREATE TABLE "PaymentCompensation" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "paymentAttemptId" UUID NOT NULL,
  "reason" "PaymentCompensationReason" NOT NULL,
  "status" "PaymentCompensationStatus" NOT NULL DEFAULT 'REQUIRED',
  "provider" VARCHAR(32) NOT NULL,
  "providerCompensationId" VARCHAR(128),
  "amountMinor" BIGINT NOT NULL,
  "currencyCode" CHAR(3) NOT NULL,
  "processingStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failureCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentCompensation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentCompensation_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PaymentCompensation_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId")
    REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PaymentCompensation_provider_check" CHECK (
    "provider" ~ '^[a-z][a-z0-9_-]{1,31}$'
  ),
  CONSTRAINT "PaymentCompensation_provider_id_check" CHECK (
    "providerCompensationId" IS NULL
    OR length("providerCompensationId") BETWEEN 1 AND 128
  ),
  CONSTRAINT "PaymentCompensation_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "PaymentCompensation_currency_check" CHECK (
    "currencyCode" ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT "PaymentCompensation_failure_code_check" CHECK (
    "failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  CONSTRAINT "PaymentCompensation_state_check" CHECK (
    ("status" = 'REQUIRED'
      AND "providerCompensationId" IS NULL
      AND "processingStartedAt" IS NULL
      AND "completedAt" IS NULL
      AND "failureCode" IS NULL)
    OR ("status" = 'PROCESSING'
      AND "providerCompensationId" IS NOT NULL
      AND "processingStartedAt" IS NOT NULL
      AND "completedAt" IS NULL
      AND "failureCode" IS NULL)
    OR ("status" = 'SUCCEEDED'
      AND "providerCompensationId" IS NOT NULL
      AND "processingStartedAt" IS NOT NULL
      AND "completedAt" >= "processingStartedAt"
      AND "failureCode" IS NULL)
    OR ("status" = 'FAILED'
      AND "providerCompensationId" IS NOT NULL
      AND "processingStartedAt" IS NOT NULL
      AND "completedAt" >= "processingStartedAt"
      AND "failureCode" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "PaymentCompensation_paymentAttemptId_key"
  ON "PaymentCompensation"("paymentAttemptId");
CREATE UNIQUE INDEX "PaymentCompensation_provider_providerCompensationId_key"
  ON "PaymentCompensation"("provider", "providerCompensationId");
CREATE INDEX "PaymentCompensation_orderId_createdAt_idx"
  ON "PaymentCompensation"("orderId", "createdAt");
CREATE INDEX "PaymentCompensation_status_createdAt_id_idx"
  ON "PaymentCompensation"("status", "createdAt", "id");

CREATE FUNCTION "enforce_payment_compensation_history"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment compensation history cannot be deleted';
  END IF;

  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'payment compensation identity and money snapshot are immutable';
  END IF;

  IF OLD."providerCompensationId" IS NOT NULL
     AND NEW."providerCompensationId" IS DISTINCT FROM OLD."providerCompensationId" THEN
    RAISE EXCEPTION 'provider compensation identity is immutable once accepted';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."providerCompensationId" IS DISTINCT FROM OLD."providerCompensationId"
       OR NEW."processingStartedAt" IS DISTINCT FROM OLD."processingStartedAt"
       OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
       OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode" THEN
      RAISE EXCEPTION 'payment compensation evidence requires a lifecycle transition';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'REQUIRED' AND NEW."status" = 'PROCESSING' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid payment compensation status transition';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentCompensation_valid_history"
  BEFORE UPDATE OR DELETE ON "PaymentCompensation"
  FOR EACH ROW EXECUTE FUNCTION "enforce_payment_compensation_history"();

CREATE FUNCTION "check_payment_compensation_consistency"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PaymentCompensation" AS compensation
    JOIN "Order" AS purchase ON purchase."id" = compensation."orderId"
    JOIN "PaymentAttempt" AS payment ON payment."id" = compensation."paymentAttemptId"
    JOIN "InventoryReservation" AS reservation ON reservation."id" = purchase."reservationId"
    WHERE payment."orderId" <> purchase."id"
       OR payment."status" <> 'SUCCEEDED'
       OR payment."provider" <> compensation."provider"
       OR payment."amountMinor" <> compensation."amountMinor"
       OR payment."currencyCode" <> compensation."currencyCode"
       OR purchase."totalMinor" <> compensation."amountMinor"
       OR purchase."currencyCode" <> compensation."currencyCode"
       OR purchase."status" <> 'MANUAL_RESOLUTION'
       OR reservation."status" <> 'EXPIRED'
       OR EXISTS (
         SELECT 1 FROM "FulfillmentGroup" AS group_record
         WHERE group_record."orderId" = purchase."id"
       )
  ) THEN
    RAISE EXCEPTION 'payment compensation does not match late-success manual resolution';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" AS purchase
    WHERE purchase."status" = 'MANUAL_RESOLUTION'
      AND (
        SELECT COUNT(*) FROM "PaymentCompensation" AS compensation
        WHERE compensation."orderId" = purchase."id"
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'manual-resolution order requires exactly one payment compensation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "PaymentCompensation_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "PaymentCompensation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_payment_compensation_consistency"();

CREATE CONSTRAINT TRIGGER "Order_payment_compensation_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "Order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_payment_compensation_consistency"();

CREATE CONSTRAINT TRIGGER "PaymentAttempt_compensation_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "PaymentAttempt"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_payment_compensation_consistency"();

CREATE CONSTRAINT TRIGGER "InventoryReservation_compensation_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "InventoryReservation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_payment_compensation_consistency"();

CREATE CONSTRAINT TRIGGER "FulfillmentGroup_compensation_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "FulfillmentGroup"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_payment_compensation_consistency"();
