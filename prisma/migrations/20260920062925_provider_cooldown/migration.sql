-- CreateTable
CREATE TABLE "ProviderCooldown" (
    "provider" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCooldown_pkey" PRIMARY KEY ("provider")
);
