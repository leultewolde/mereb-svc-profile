-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "handle" VARCHAR(32) NOT NULL,
    "displayName" VARCHAR(80) NOT NULL,
    "bio" VARCHAR(280),
    "avatarKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");
