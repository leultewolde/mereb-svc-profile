CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

ALTER TABLE "User"
ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "deactivatedAt" TIMESTAMP(3);

CREATE INDEX "User_status_createdAt_id_idx"
ON "User"("status", "createdAt", "id");
