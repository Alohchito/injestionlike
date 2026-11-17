ALTER TYPE "BillingCurrency" ADD VALUE IF NOT EXISTS 'XOF';
ALTER TYPE "BillingCurrency" ADD VALUE IF NOT EXISTS 'GHS';
ALTER TYPE "BillingCurrency" ADD VALUE IF NOT EXISTS 'NGN';

ALTER TABLE "Subscription"
  ADD COLUMN "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'STRIPE',
  ADD COLUMN "paymentMethod" TEXT,
  ADD COLUMN "countryCode" VARCHAR(2);

ALTER TABLE "Subscription" ALTER COLUMN "amount" DROP DEFAULT;
ALTER TABLE "Subscription" ALTER COLUMN "provider" DROP DEFAULT;

ALTER TABLE "Subscription" RENAME COLUMN "stripeCustomerId" TO "providerCustomerId";
ALTER TABLE "Subscription" RENAME COLUMN "stripeCheckoutSessionId" TO "checkoutSessionId";
ALTER TABLE "Subscription" RENAME COLUMN "stripeSubscriptionId" TO "providerSubscriptionId";
ALTER TABLE "Subscription" RENAME COLUMN "stripePaymentIntentId" TO "providerPaymentId";

DROP INDEX IF EXISTS "Subscription_stripeCheckoutSessionId_key";
DROP INDEX IF EXISTS "Subscription_stripeSubscriptionId_key";
DROP INDEX IF EXISTS "Subscription_stripePaymentIntentId_key";

CREATE UNIQUE INDEX "Subscription_provider_checkoutSessionId_key"
  ON "Subscription"("provider", "checkoutSessionId");
CREATE UNIQUE INDEX "Subscription_provider_providerSubscriptionId_key"
  ON "Subscription"("provider", "providerSubscriptionId");
CREATE UNIQUE INDEX "Subscription_provider_providerPaymentId_key"
  ON "Subscription"("provider", "providerPaymentId");
CREATE INDEX "Subscription_provider_status_paymentStatus_idx"
  ON "Subscription"("provider", "status", "paymentStatus");

ALTER TABLE "PaymentEvent"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'STRIPE';
ALTER TABLE "PaymentEvent" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "PaymentEvent" RENAME COLUMN "stripeEventId" TO "providerEventId";

DROP INDEX IF EXISTS "PaymentEvent_stripeEventId_key";
CREATE UNIQUE INDEX "PaymentEvent_provider_providerEventId_key"
  ON "PaymentEvent"("provider", "providerEventId");
