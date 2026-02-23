-- CreateEnum
CREATE TYPE "ProfileOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "ProfileOutboxEvent" (
    "id" TEXT NOT NULL,
    "topic" VARCHAR(128) NOT NULL,
    "eventType" VARCHAR(128) NOT NULL,
    "eventKey" VARCHAR(128),
    "payload" JSONB NOT NULL,
    "status" "ProfileOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileOutboxEvent_status_nextAttemptAt_createdAt_idx" ON "ProfileOutboxEvent"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "ProfileOutboxEvent_createdAt_idx" ON "ProfileOutboxEvent"("createdAt");
