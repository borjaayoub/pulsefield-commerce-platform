-- Phase 4 Slice 4.1: provider-neutral payment lifecycle and verified-event inbox.
-- This migration performs no provider calls and stores no raw webhook payloads.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'MANUAL_RESOLUTION';
ALTER TYPE "PaymentAttemptStatus" ADD VALUE IF NOT EXISTS 'REQUIRES_PAYMENT_METHOD' BEFORE 'PROCESSING';

CREATE TYPE "PaymentWebhookEventType" AS ENUM (
  'REQUIRES_PAYMENT_METHOD',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED'
);

CREATE TYPE "PaymentWebhookInboxStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'TERMINAL_FAILURE'
);

CREATE TABLE "PaymentWebhookInbox" (
  "id" UUID NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "providerEventId" VARCHAR(128) NOT NULL,
  "eventType" "PaymentWebhookEventType" NOT NULL,
  "providerObjectId" VARCHAR(128) NOT NULL,
  "apiVersion" VARCHAR(32) NOT NULL,
  "livemode" BOOLEAN NOT NULL,
  "providerCreatedAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "normalizedData" JSONB NOT NULL,
  "payloadDigest" CHAR(64) NOT NULL,
  "status" "PaymentWebhookInboxStatus" NOT NULL DEFAULT 'PENDING',
  "processingAttempts" INTEGER NOT NULL DEFAULT 0,
  "claimTokenDigest" CHAR(64),
  "claimedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "failureCode" VARCHAR(64),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentWebhookInbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentWebhookInbox_provider_format_check" CHECK (
    "provider" ~ '^[a-z][a-z0-9_-]{1,31}$'
  ),
  CONSTRAINT "PaymentWebhookInbox_provider_event_id_check" CHECK (
    length("providerEventId") BETWEEN 1 AND 128
  ),
  CONSTRAINT "PaymentWebhookInbox_provider_object_id_check" CHECK (
    length("providerObjectId") BETWEEN 1 AND 128
  ),
  CONSTRAINT "PaymentWebhookInbox_api_version_check" CHECK (
    "apiVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'
  ),
  CONSTRAINT "PaymentWebhookInbox_test_mode_only_check" CHECK ("livemode" = FALSE),
  CONSTRAINT "PaymentWebhookInbox_payload_digest_check" CHECK (
    "payloadDigest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "PaymentWebhookInbox_normalized_data_check" CHECK (
    jsonb_typeof("normalizedData") = 'object'
    AND octet_length("normalizedData"::text) <= 8192
  ),
  CONSTRAINT "PaymentWebhookInbox_attempts_check" CHECK (
    "processingAttempts" BETWEEN 0 AND 25
  ),
  CONSTRAINT "PaymentWebhookInbox_failure_code_check" CHECK (
    "failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  CONSTRAINT "PaymentWebhookInbox_state_check" CHECK (
    ("status" = 'PENDING'
      AND "claimTokenDigest" IS NULL
      AND "claimedAt" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "processedAt" IS NULL
      AND "failureCode" IS NULL)
    OR ("status" = 'PROCESSING'
      AND "processingAttempts" >= 1
      AND "claimTokenDigest" ~ '^[0-9a-f]{64}$'
      AND "claimedAt" IS NOT NULL
      AND "leaseExpiresAt" > "claimedAt"
      AND "processedAt" IS NULL
      AND "failureCode" IS NULL)
    OR ("status" = 'PROCESSED'
      AND "processingAttempts" >= 1
      AND "claimTokenDigest" IS NULL
      AND "claimedAt" IS NOT NULL
      AND "leaseExpiresAt" IS NULL
      AND "processedAt" >= "claimedAt"
      AND "failureCode" IS NULL)
    OR ("status" = 'TERMINAL_FAILURE'
      AND "processingAttempts" >= 1
      AND "claimTokenDigest" IS NULL
      AND "claimedAt" IS NOT NULL
      AND "leaseExpiresAt" IS NULL
      AND "processedAt" >= "claimedAt"
      AND "failureCode" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "PaymentWebhookInbox_provider_providerEventId_key"
  ON "PaymentWebhookInbox"("provider", "providerEventId");
CREATE INDEX "PaymentWebhookInbox_status_receivedAt_id_idx"
  ON "PaymentWebhookInbox"("status", "receivedAt", "id");
CREATE INDEX "PaymentWebhookInbox_provider_providerObjectId_providerCreatedAt_idx"
  ON "PaymentWebhookInbox"("provider", "providerObjectId", "providerCreatedAt");

CREATE OR REPLACE FUNCTION "enforce_payment_webhook_inbox_update"()
RETURNS trigger AS $$
BEGIN
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."providerEventId" IS DISTINCT FROM OLD."providerEventId"
     OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
     OR NEW."providerObjectId" IS DISTINCT FROM OLD."providerObjectId"
     OR NEW."apiVersion" IS DISTINCT FROM OLD."apiVersion"
     OR NEW."livemode" IS DISTINCT FROM OLD."livemode"
     OR NEW."providerCreatedAt" IS DISTINCT FROM OLD."providerCreatedAt"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
     OR NEW."normalizedData" IS DISTINCT FROM OLD."normalizedData"
     OR NEW."payloadDigest" IS DISTINCT FROM OLD."payloadDigest" THEN
    RAISE EXCEPTION 'accepted payment webhook evidence is immutable';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."processingAttempts" IS DISTINCT FROM OLD."processingAttempts"
       OR NEW."claimTokenDigest" IS DISTINCT FROM OLD."claimTokenDigest"
       OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
       OR NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt"
       OR NEW."processedAt" IS DISTINCT FROM OLD."processedAt"
       OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode" THEN
      RAISE EXCEPTION 'payment webhook processing fields require a lifecycle transition';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PENDING' AND NEW."status" = 'PROCESSING' THEN
    IF NEW."processingAttempts" <> OLD."processingAttempts" + 1 THEN
      RAISE EXCEPTION 'payment webhook claim must increment attempts exactly once';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PROCESSING'
     AND NEW."status" IN ('PROCESSED', 'TERMINAL_FAILURE') THEN
    IF NEW."processingAttempts" <> OLD."processingAttempts" THEN
      RAISE EXCEPTION 'payment webhook completion cannot change attempts';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PROCESSING' AND NEW."status" = 'PENDING' THEN
    IF OLD."leaseExpiresAt" > CURRENT_TIMESTAMP
       OR NEW."processingAttempts" <> OLD."processingAttempts" THEN
      RAISE EXCEPTION 'payment webhook retry requires an expired lease';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid payment webhook inbox transition';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentWebhookInbox_valid_update"
  BEFORE UPDATE ON "PaymentWebhookInbox"
  FOR EACH ROW EXECUTE FUNCTION "enforce_payment_webhook_inbox_update"();

CREATE OR REPLACE FUNCTION "enforce_payment_attempt_transition"()
RETURNS trigger AS $$
BEGIN
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."paymentMethodReference" IS DISTINCT FROM OLD."paymentMethodReference"
     OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'payment attempt identity and money snapshot are immutable';
  END IF;

  IF OLD."providerPaymentId" IS NOT NULL
     AND NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId" THEN
    RAISE EXCEPTION 'provider payment identity is immutable once accepted';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    IF NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
       OR NEW."providerReference" IS DISTINCT FROM OLD."providerReference"
       OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode" THEN
      RAISE EXCEPTION 'payment attempt evidence requires a lifecycle transition';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD."status" = 'REQUIRES_PAYMENT_METHOD' AND NEW."status" IN ('PROCESSING', 'FAILED'))
     OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('SUCCEEDED', 'FAILED')) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid payment attempt status transition';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentAttempt_valid_transition"
  BEFORE UPDATE ON "PaymentAttempt"
  FOR EACH ROW EXECUTE FUNCTION "enforce_payment_attempt_transition"();
