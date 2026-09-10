-- CreateEnum
CREATE TYPE "NotificationDeliveryType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RECOVERY');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('QUEUED', 'ACCEPTED', 'FAILED_TERMINAL');

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "sourceEventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationDeliveryType" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "correlationId" VARCHAR(128) NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" VARCHAR(64),
    "workerAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NotificationDelivery_workerAttemptCount_check" CHECK ("workerAttemptCount" >= 0),
    CONSTRAINT "NotificationDelivery_state_check" CHECK (
      ("status" = 'QUEUED' AND "acceptedAt" IS NULL AND "failedAt" IS NULL AND "failureCode" IS NULL)
      OR ("status" = 'ACCEPTED' AND "acceptedAt" IS NOT NULL AND "failedAt" IS NULL AND "failureCode" IS NULL)
      OR ("status" = 'FAILED_TERMINAL' AND "acceptedAt" IS NULL AND "failedAt" IS NOT NULL AND "failureCode" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_sourceEventId_key" ON "NotificationDelivery"("sourceEventId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_queuedAt_idx" ON "NotificationDelivery"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_userId_queuedAt_idx" ON "NotificationDelivery"("userId", "queuedAt");

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
