-- Phase 1: Foundation-only persisted configuration.
CREATE TABLE "FoundationSetting" (
    "key" VARCHAR(128) NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoundationSetting_pkey" PRIMARY KEY ("key")
);
