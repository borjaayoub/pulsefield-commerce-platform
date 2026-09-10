-- Backfill Phase 1's active projection as immutable version-one history.
INSERT INTO "FoundationSettingRevision" (
    "id",
    "settingKey",
    "version",
    "value",
    "lifecycle",
    "validationResult",
    "authoredBy",
    "approvedBy",
    "activatedBy",
    "effectiveFrom",
    "lockVersion",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    "key",
    "version",
    "value",
    'ACTIVE'::"FoundationSettingLifecycle",
    '{"valid":true,"issues":[]}'::jsonb,
    'system:phase-1-seed',
    'system:phase-1-seed',
    'system:phase-1-seed',
    "createdAt",
    1,
    "createdAt",
    "updatedAt"
FROM "FoundationSetting";

