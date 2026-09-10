-- CreateEnum
CREATE TYPE "FoundationSettingLifecycle" AS ENUM ('DRAFT', 'APPROVED', 'ACTIVE', 'RETIRED');

-- AlterTable
ALTER TABLE "FoundationSetting"
ADD COLUMN "latestRevision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "FoundationSettingRevision" (
    "id" UUID NOT NULL,
    "settingKey" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "lifecycle" "FoundationSettingLifecycle" NOT NULL,
    "validationResult" JSONB NOT NULL,
    "authoredBy" VARCHAR(128) NOT NULL,
    "approvedBy" VARCHAR(128),
    "activatedBy" VARCHAR(128),
    "retiredBy" VARCHAR(128),
    "sourceRevisionVersion" INTEGER,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveUntil" TIMESTAMP(3),
    "lockVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoundationSettingRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FoundationSettingRevision_positive_versions_check"
      CHECK ("version" > 0 AND "lockVersion" > 0),
    CONSTRAINT "FoundationSettingRevision_validation_result_check"
      CHECK (
        jsonb_typeof("validationResult") = 'object'
        AND jsonb_typeof("validationResult" -> 'valid') = 'boolean'
        AND jsonb_typeof("validationResult" -> 'issues') = 'array'
      ),
    CONSTRAINT "FoundationSettingRevision_lifecycle_metadata_check"
      CHECK (
        ("lifecycle" = 'DRAFT' AND "approvedBy" IS NULL AND "activatedBy" IS NULL AND "retiredBy" IS NULL AND "effectiveFrom" IS NULL AND "effectiveUntil" IS NULL)
        OR ("lifecycle" = 'APPROVED' AND "approvedBy" IS NOT NULL AND "activatedBy" IS NULL AND "retiredBy" IS NULL AND "effectiveFrom" IS NULL AND "effectiveUntil" IS NULL)
        OR ("lifecycle" = 'ACTIVE' AND "approvedBy" IS NOT NULL AND "activatedBy" IS NOT NULL AND "retiredBy" IS NULL AND "effectiveFrom" IS NOT NULL AND "effectiveUntil" IS NULL)
        OR ("lifecycle" = 'RETIRED' AND "approvedBy" IS NOT NULL AND "activatedBy" IS NOT NULL AND "retiredBy" IS NOT NULL AND "effectiveFrom" IS NOT NULL AND "effectiveUntil" IS NOT NULL AND "effectiveUntil" >= "effectiveFrom")
      )
);

-- CreateIndex
CREATE UNIQUE INDEX "FoundationSettingRevision_settingKey_version_key"
ON "FoundationSettingRevision"("settingKey", "version");

-- CreateIndex
CREATE INDEX "FoundationSettingRevision_settingKey_lifecycle_idx"
ON "FoundationSettingRevision"("settingKey", "lifecycle");

-- Only one revision may represent the active value for a setting.
CREATE UNIQUE INDEX "FoundationSettingRevision_one_active_per_setting_key"
ON "FoundationSettingRevision"("settingKey")
WHERE "lifecycle" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "FoundationSettingRevision"
ADD CONSTRAINT "FoundationSettingRevision_settingKey_fkey"
FOREIGN KEY ("settingKey") REFERENCES "FoundationSetting"("key")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Revision payload and attribution are immutable; only lifecycle metadata may advance.
CREATE FUNCTION prevent_foundation_setting_revision_payload_update()
RETURNS trigger AS $$
BEGIN
  IF NEW."settingKey" IS DISTINCT FROM OLD."settingKey"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."value" IS DISTINCT FROM OLD."value"
    OR NEW."validationResult" IS DISTINCT FROM OLD."validationResult"
    OR NEW."authoredBy" IS DISTINCT FROM OLD."authoredBy"
    OR NEW."sourceRevisionVersion" IS DISTINCT FROM OLD."sourceRevisionVersion"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'foundation setting revision payload is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FoundationSettingRevision_immutable_payload"
BEFORE UPDATE ON "FoundationSettingRevision"
FOR EACH ROW EXECUTE FUNCTION prevent_foundation_setting_revision_payload_update();

