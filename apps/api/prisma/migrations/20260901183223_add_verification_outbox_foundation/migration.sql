-- CreateEnum
CREATE TYPE "OutboxMessageStatus" AS ENUM ('PENDING', 'PUBLISHED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" UUID NOT NULL,
    "eventType" VARCHAR(128) NOT NULL,
    "eventVersion" INTEGER NOT NULL,
    "aggregateType" VARCHAR(128) NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "correlationId" VARCHAR(128) NOT NULL,
    "causationId" VARCHAR(128),
    "status" "OutboxMessageStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" VARCHAR(128),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(2000),
    "publishedAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_expiresAt_idx" ON "EmailVerificationToken"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_availableAt_occurredAt_idx" ON "OutboxMessage"("status", "availableAt", "occurredAt");

-- CreateIndex
CREATE INDEX "OutboxMessage_claimedAt_idx" ON "OutboxMessage"("claimedAt");

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraints
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_expiry_check" CHECK ("expiresAt" > "createdAt");

ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_event_version_check" CHECK ("eventVersion" > 0);

ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_attempt_count_check" CHECK ("attemptCount" >= 0);

ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_claim_lease_check" CHECK (("claimedAt" IS NULL) = ("claimedBy" IS NULL));

ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_terminal_state_check" CHECK (
    ("status" = 'PENDING' AND "publishedAt" IS NULL AND "deadLetteredAt" IS NULL)
    OR ("status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "deadLetteredAt" IS NULL)
    OR ("status" = 'DEAD_LETTER' AND "publishedAt" IS NULL AND "deadLetteredAt" IS NOT NULL)
);
