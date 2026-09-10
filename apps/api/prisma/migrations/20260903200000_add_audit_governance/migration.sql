-- CreateTable
CREATE TABLE "AuditRetentionHold" (
    "id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "createdBy" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditRetentionHold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditRetentionHold_fields_check" CHECK (
      length("reason") > 0
      AND length("createdBy") > 0
      AND "expiresAt" > "createdAt"
      AND (("releasedAt" IS NULL AND "releasedBy" IS NULL)
        OR ("releasedAt" IS NOT NULL AND "releasedBy" IS NOT NULL AND "releasedAt" >= "createdAt"))
    )
);

-- CreateIndex
CREATE INDEX "AuditRetentionHold_releasedAt_expiresAt_idx"
ON "AuditRetentionHold"("releasedAt", "expiresAt");

-- Investigation holds may be released once, but their original evidence cannot be rewritten or deleted.
CREATE FUNCTION enforce_audit_retention_hold_history()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit retention holds cannot be deleted';
  END IF;

  IF OLD."id" <> NEW."id"
    OR OLD."reason" <> NEW."reason"
    OR OLD."createdBy" <> NEW."createdBy"
    OR OLD."expiresAt" <> NEW."expiresAt"
    OR OLD."createdAt" <> NEW."createdAt"
    OR OLD."releasedAt" IS NOT NULL
    OR NEW."releasedAt" IS NULL
    OR NEW."releasedBy" IS NULL THEN
    RAISE EXCEPTION 'audit retention hold history is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditRetentionHold_history"
BEFORE UPDATE OR DELETE ON "AuditRetentionHold"
FOR EACH ROW EXECUTE FUNCTION enforce_audit_retention_hold_history();

-- Replace the original unconditional guard with a narrow retention exception.
-- Direct updates always fail. Deletes succeed only inside the explicit retention
-- transaction, for records already older than the canonical 30-day limit, and
-- while no investigation hold is active.
DROP TRIGGER "AuditRecord_append_only" ON "AuditRecord";

CREATE OR REPLACE FUNCTION reject_audit_record_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting('pulse_field.audit_retention', true) = 'enabled'
    AND OLD."occurredAt" < CURRENT_TIMESTAMP - INTERVAL '30 days'
    AND NOT EXISTS (
      SELECT 1
      FROM "AuditRetentionHold"
      WHERE "releasedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP
    ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit records are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditRecord_append_only"
BEFORE UPDATE OR DELETE ON "AuditRecord"
FOR EACH ROW EXECUTE FUNCTION reject_audit_record_mutation();
