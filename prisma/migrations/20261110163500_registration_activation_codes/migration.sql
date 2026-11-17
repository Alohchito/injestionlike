ALTER TABLE "User"
  ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ(6),
  ADD COLUMN "emailVerificationCodeHash" TEXT,
  ADD COLUMN "emailVerificationExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "emailVerificationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "activationCode" TEXT;

UPDATE "User"
SET "emailVerifiedAt" = "registeredAt"
WHERE "emailVerifiedAt" IS NULL;

CREATE UNIQUE INDEX "User_activationCode_key"
  ON "User"("activationCode");
