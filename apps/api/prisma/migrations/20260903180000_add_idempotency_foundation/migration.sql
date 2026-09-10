-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED_RETRYABLE');

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" VARCHAR(128) NOT NULL,
    "operation" VARCHAR(128) NOT NULL,
    "keyDigest" CHAR(64) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "claimTokenDigest" CHAR(64),
    "lockedUntil" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "resultType" VARCHAR(128),
    "resultId" VARCHAR(128),
    "responseStatus" INTEGER,
    "lastErrorCode" VARCHAR(64),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdempotencyRecord_attemptCount_check" CHECK ("attemptCount" > 0),
    CONSTRAINT "IdempotencyRecord_keyDigest_check" CHECK ("keyDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "IdempotencyRecord_requestFingerprint_check" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "IdempotencyRecord_claimTokenDigest_check" CHECK ("claimTokenDigest" IS NULL OR "claimTokenDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "IdempotencyRecord_responseStatus_check" CHECK ("responseStatus" IS NULL OR "responseStatus" BETWEEN 200 AND 299),
    CONSTRAINT "IdempotencyRecord_expiry_check" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "IdempotencyRecord_state_check" CHECK (
      ("status" = 'IN_PROGRESS' AND "claimTokenDigest" IS NOT NULL AND "lockedUntil" IS NOT NULL AND "resultType" IS NULL AND "resultId" IS NULL AND "responseStatus" IS NULL AND "completedAt" IS NULL AND "lastErrorCode" IS NULL)
      OR
      ("status" = 'COMPLETED' AND "claimTokenDigest" IS NULL AND "lockedUntil" IS NULL AND "resultType" IS NOT NULL AND "resultId" IS NOT NULL AND "responseStatus" IS NOT NULL AND "completedAt" IS NOT NULL AND "lastErrorCode" IS NULL)
      OR
      ("status" = 'FAILED_RETRYABLE' AND "claimTokenDigest" IS NULL AND "lockedUntil" IS NULL AND "resultType" IS NULL AND "resultId" IS NULL AND "responseStatus" IS NULL AND "completedAt" IS NULL AND "lastErrorCode" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_actorType_actorId_operation_keyDigest_key" ON "IdempotencyRecord"("actorType", "actorId", "operation", "keyDigest");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_status_lockedUntil_idx" ON "IdempotencyRecord"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
