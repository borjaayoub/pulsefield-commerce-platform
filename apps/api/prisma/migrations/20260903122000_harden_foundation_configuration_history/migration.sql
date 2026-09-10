-- Projection versions are positive and the allocation counter never trails the active version.
ALTER TABLE "FoundationSetting"
ADD CONSTRAINT "FoundationSetting_version_order_check"
CHECK ("version" > 0 AND "latestRevision" >= "version");

-- A copied revision may reference only an earlier positive version.
ALTER TABLE "FoundationSettingRevision"
ADD CONSTRAINT "FoundationSettingRevision_source_version_check"
CHECK (
  "sourceRevisionVersion" IS NULL
  OR ("sourceRevisionVersion" > 0 AND "sourceRevisionVersion" < "version")
);

-- Revision payloads are immutable and lifecycle metadata may advance only once:
-- DRAFT -> APPROVED or ACTIVE -> RETIRED.
CREATE OR REPLACE FUNCTION prevent_foundation_setting_revision_payload_update()
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

  IF NEW."lockVersion" <> OLD."lockVersion" + 1 THEN
    RAISE EXCEPTION 'foundation setting revision lock version must advance exactly once';
  END IF;

  IF OLD."lifecycle" = 'DRAFT' AND NEW."lifecycle" = 'APPROVED' THEN
    IF NEW."approvedBy" IS NULL
      OR NEW."activatedBy" IS DISTINCT FROM OLD."activatedBy"
      OR NEW."retiredBy" IS DISTINCT FROM OLD."retiredBy"
      OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
      OR NEW."effectiveUntil" IS DISTINCT FROM OLD."effectiveUntil"
    THEN
      RAISE EXCEPTION 'invalid foundation setting approval metadata';
    END IF;
  ELSIF OLD."lifecycle" = 'ACTIVE' AND NEW."lifecycle" = 'RETIRED' THEN
    IF NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
      OR NEW."activatedBy" IS DISTINCT FROM OLD."activatedBy"
      OR NEW."retiredBy" IS NULL
      OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
      OR NEW."effectiveUntil" IS NULL
    THEN
      RAISE EXCEPTION 'invalid foundation setting retirement metadata';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid foundation setting revision lifecycle transition';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

