-- AlterTable
ALTER TABLE "NotificationDelivery"
ADD COLUMN "replayedAt" TIMESTAMP(3),
ADD COLUMN "replayedBy" VARCHAR(128);

-- AddConstraint
ALTER TABLE "NotificationDelivery"
ADD CONSTRAINT "NotificationDelivery_replay_evidence_check" CHECK (
  ("replayedAt" IS NULL AND "replayedBy" IS NULL)
  OR ("replayedAt" IS NOT NULL AND length("replayedBy") > 0)
);
