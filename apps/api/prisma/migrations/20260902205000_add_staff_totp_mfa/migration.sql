-- AlterTable
ALTER TABLE "User"
ADD COLUMN "totpSecretCiphertext" TEXT,
ADD COLUMN "totpEnrolledAt" TIMESTAMP(3),
ADD COLUMN "totpLastUsedStep" BIGINT;

-- CreateTable
CREATE TABLE "MfaRecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaRecoveryCode_codeHash_key" ON "MfaRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "MfaRecoveryCode_userId_usedAt_idx" ON "MfaRecoveryCode"("userId", "usedAt");

-- AddForeignKey
ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "User" ADD CONSTRAINT "User_totp_enrollment_consistency_check"
CHECK (
    ("totpSecretCiphertext" IS NULL AND "totpEnrolledAt" IS NULL AND "totpLastUsedStep" IS NULL)
    OR
    ("totpSecretCiphertext" IS NOT NULL AND "totpEnrolledAt" IS NOT NULL AND ("totpLastUsedStep" IS NULL OR "totpLastUsedStep" >= 0))
);

-- Invalidate any password-only sessions belonging to existing staff accounts.
UPDATE "User"
SET "credentialVersion" = "credentialVersion" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
    SELECT 1
    FROM "UserRole"
    WHERE "UserRole"."userId" = "User"."id"
      AND "UserRole"."role" IN ('FULFILLER', 'ADMINISTRATOR')
);
