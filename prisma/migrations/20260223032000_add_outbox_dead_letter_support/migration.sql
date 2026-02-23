-- Add enum value for terminal outbox state
ALTER TYPE "ProfileOutboxStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTER';

-- Add dead-letter metadata columns
ALTER TABLE "ProfileOutboxEvent"
ADD COLUMN "deadLetteredAt" TIMESTAMP(3),
ADD COLUMN "deadLetterTopic" VARCHAR(128);
