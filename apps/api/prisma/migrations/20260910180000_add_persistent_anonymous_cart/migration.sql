CREATE TABLE "Cart" (
    "id" UUID NOT NULL,
    "tokenDigest" CHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CartItem" (
    "id" UUID NOT NULL,
    "cartId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Cart_tokenDigest_key" ON "Cart"("tokenDigest");
CREATE INDEX "Cart_expiresAt_idx" ON "Cart"("expiresAt");
CREATE INDEX "Cart_absoluteExpiresAt_idx" ON "Cart"("absoluteExpiresAt");
CREATE INDEX "Cart_lastAccessedAt_idx" ON "Cart"("lastAccessedAt");
CREATE UNIQUE INDEX "CartItem_cartId_variantId_key" ON "CartItem"("cartId", "variantId");
CREATE INDEX "CartItem_variantId_idx" ON "CartItem"("variantId");

ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey"
  FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Cart" ADD CONSTRAINT "Cart_revision_positive_check" CHECK ("revision" > 0);
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_expiry_order_check"
  CHECK ("expiresAt" >= "createdAt" AND "absoluteExpiresAt" >= "expiresAt");
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_quantity_range_check" CHECK ("quantity" BETWEEN 1 AND 99);
