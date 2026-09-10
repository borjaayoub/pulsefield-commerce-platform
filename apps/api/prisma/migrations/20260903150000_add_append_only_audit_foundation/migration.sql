-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('CUSTOMER', 'STAFF', 'SYSTEM');

-- CreateTable
CREATE TABLE "AuditRecord" (
    "id" UUID NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" VARCHAR(128) NOT NULL,
    "actorRoles" TEXT[] NOT NULL,
    "action" VARCHAR(128) NOT NULL,
    "targetType" VARCHAR(128) NOT NULL,
    "targetId" VARCHAR(128) NOT NULL,
    "requestId" VARCHAR(128) NOT NULL,
    "correlationId" VARCHAR(128) NOT NULL,
    "causationId" VARCHAR(128),
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "beforeMetadata" JSONB,
    "afterMetadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditRecord_schema_version_check" CHECK ("schemaVersion" = 1),
    CONSTRAINT "AuditRecord_identifiers_check" CHECK (
      length("actorId") > 0
      AND length("action") > 0
      AND length("targetType") > 0
      AND length("targetId") > 0
      AND length("requestId") >= 8
      AND length("correlationId") >= 8
      AND length("idempotencyKey") >= 8
      AND length("reason") > 0
    ),
    CONSTRAINT "AuditRecord_action_format_check" CHECK (
      "action" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'
      AND "targetType" ~ '^[a-z][a-z0-9.-]*$'
    ),
    CONSTRAINT "AuditRecord_roles_check" CHECK (
      cardinality("actorRoles") <= 16
      AND array_position("actorRoles", '') IS NULL
    ),
    CONSTRAINT "AuditRecord_metadata_shape_check" CHECK (
      ("beforeMetadata" IS NULL OR jsonb_typeof("beforeMetadata") = 'object')
      AND ("afterMetadata" IS NULL OR jsonb_typeof("afterMetadata") = 'object')
    )
);

-- CreateIndex
CREATE INDEX "AuditRecord_occurredAt_idx" ON "AuditRecord"("occurredAt");

-- CreateIndex
CREATE INDEX "AuditRecord_actorType_actorId_occurredAt_idx"
ON "AuditRecord"("actorType", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditRecord_targetType_targetId_occurredAt_idx"
ON "AuditRecord"("targetType", "targetId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditRecord_correlationId_occurredAt_idx"
ON "AuditRecord"("correlationId", "occurredAt");

-- Ordinary application code may append audit evidence but cannot rewrite or delete it.
CREATE FUNCTION reject_audit_record_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditRecord_append_only"
BEFORE UPDATE OR DELETE ON "AuditRecord"
FOR EACH ROW EXECUTE FUNCTION reject_audit_record_mutation();

