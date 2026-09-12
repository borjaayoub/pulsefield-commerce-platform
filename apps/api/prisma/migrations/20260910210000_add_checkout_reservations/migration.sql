CREATE TYPE "CartStatus" AS ENUM ('OPEN', 'CHECKOUT_PENDING', 'CONVERTED');
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'COMMITTED', 'RELEASED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED');
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "FulfillmentGroupStatus" AS ENUM ('ALLOCATED');

ALTER TABLE "Cart" ADD COLUMN "status" "CartStatus" NOT NULL DEFAULT 'OPEN';

CREATE TABLE "CommercePolicyVersion" (
  "id" UUID NOT NULL, "version" INTEGER NOT NULL, "countryCode" CHAR(2) NOT NULL,
  "currencyCode" CHAR(3) NOT NULL, "shippingBaseMinor" INTEGER NOT NULL,
  "freeShippingThresholdMinor" INTEGER NOT NULL, "heavySurchargeMinor" INTEGER NOT NULL,
  "heavyThresholdGrams" INTEGER NOT NULL, "taxRateBasisPoints" INTEGER NOT NULL,
  "reservationDurationSeconds" INTEGER NOT NULL, "calculationVersion" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercePolicyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercePolicyVersion_version_key" UNIQUE ("version"),
  CONSTRAINT "CommercePolicyVersion_us_usd_check" CHECK ("countryCode" = 'US' AND "currencyCode" = 'USD'),
  CONSTRAINT "CommercePolicyVersion_values_check" CHECK ("shippingBaseMinor" >= 0 AND "freeShippingThresholdMinor" >= 0 AND "heavySurchargeMinor" >= 0 AND "heavyThresholdGrams" > 0 AND "taxRateBasisPoints" >= 0 AND "reservationDurationSeconds" > 0)
);

CREATE TABLE "InventoryReservation" (
  "id" UUID NOT NULL, "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryReservation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InventoryReservation_status_expiresAt_idx" ON "InventoryReservation"("status", "expiresAt");

CREATE TABLE "InventoryReservationItem" (
  "id" UUID NOT NULL, "reservationId" UUID NOT NULL, "warehouseId" UUID NOT NULL,
  "variantId" UUID NOT NULL, "quantity" INTEGER NOT NULL,
  CONSTRAINT "InventoryReservationItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryReservationItem_quantity_check" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "InventoryReservationItem_reservationId_variantId_key" ON "InventoryReservationItem"("reservationId", "variantId");
CREATE INDEX "InventoryReservationItem_warehouseId_variantId_idx" ON "InventoryReservationItem"("warehouseId", "variantId");

CREATE TABLE "Order" (
  "id" UUID NOT NULL, "reference" VARCHAR(32) NOT NULL, "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "cartId" UUID NOT NULL, "policyVersionId" UUID NOT NULL, "reservationId" UUID NOT NULL,
  "currencyCode" CHAR(3) NOT NULL, "subtotalMinor" BIGINT NOT NULL, "shippingMinor" BIGINT NOT NULL,
  "taxMinor" BIGINT NOT NULL, "totalMinor" BIGINT NOT NULL, "calculationSnapshot" JSONB NOT NULL,
  "shippingAddressSnapshot" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Order_pkey" PRIMARY KEY ("id"), CONSTRAINT "Order_reference_key" UNIQUE ("reference"),
  CONSTRAINT "Order_reservationId_key" UNIQUE ("reservationId"),
  CONSTRAINT "Order_currency_total_check" CHECK ("currencyCode" = 'USD' AND "subtotalMinor" >= 0 AND "shippingMinor" >= 0 AND "taxMinor" >= 0 AND "totalMinor" = "subtotalMinor" + "shippingMinor" + "taxMinor")
);
CREATE INDEX "Order_cartId_createdAt_idx" ON "Order"("cartId", "createdAt");
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

CREATE TABLE "OrderLine" (
  "id" UUID NOT NULL, "orderId" UUID NOT NULL, "variantId" UUID NOT NULL,
  "productNameSnapshot" VARCHAR(160) NOT NULL, "skuSnapshot" VARCHAR(64) NOT NULL,
  "optionValuesSnapshot" JSONB NOT NULL, "taxClassSnapshot" VARCHAR(64) NOT NULL,
  "weightGramsSnapshot" INTEGER NOT NULL, "quantity" INTEGER NOT NULL, "unitPriceMinor" BIGINT NOT NULL,
  "lineSubtotalMinor" BIGINT NOT NULL, "lineTaxMinor" BIGINT NOT NULL, "lineTotalMinor" BIGINT NOT NULL,
  CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderLine_values_check" CHECK ("weightGramsSnapshot" >= 0 AND "quantity" > 0 AND "unitPriceMinor" >= 0 AND "lineSubtotalMinor" = "quantity" * "unitPriceMinor" AND "lineTaxMinor" >= 0 AND "lineTotalMinor" = "lineSubtotalMinor" + "lineTaxMinor")
);
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

CREATE TABLE "PaymentAttempt" (
  "id" UUID NOT NULL, "orderId" UUID NOT NULL, "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PROCESSING',
  "provider" VARCHAR(32) NOT NULL, "paymentMethodReference" VARCHAR(64) NOT NULL,
  "providerPaymentId" VARCHAR(128), "providerReference" VARCHAR(128), "failureCode" VARCHAR(64),
  "amountMinor" BIGINT NOT NULL, "currencyCode" CHAR(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAttempt_currency_amount_check" CHECK ("currencyCode" = 'USD' AND "amountMinor" >= 0)
);
CREATE INDEX "PaymentAttempt_orderId_createdAt_idx" ON "PaymentAttempt"("orderId", "createdAt");

CREATE TABLE "FulfillmentGroup" (
  "id" UUID NOT NULL, "orderId" UUID NOT NULL, "warehouseId" UUID NOT NULL,
  "status" "FulfillmentGroupStatus" NOT NULL DEFAULT 'ALLOCATED', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FulfillmentGroup_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FulfillmentGroup_orderId_idx" ON "FulfillmentGroup"("orderId");
CREATE TABLE "FulfillmentGroupItem" (
  "id" UUID NOT NULL, "fulfillmentGroupId" UUID NOT NULL, "variantId" UUID NOT NULL, "quantity" INTEGER NOT NULL,
  CONSTRAINT "FulfillmentGroupItem_pkey" PRIMARY KEY ("id"), CONSTRAINT "FulfillmentGroupItem_quantity_check" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "FulfillmentGroupItem_fulfillmentGroupId_variantId_key" ON "FulfillmentGroupItem"("fulfillmentGroupId", "variantId");

ALTER TABLE "InventoryReservationItem" ADD CONSTRAINT "InventoryReservationItem_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "InventoryReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryReservationItem" ADD CONSTRAINT "InventoryReservationItem_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryReservationItem" ADD CONSTRAINT "InventoryReservationItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "CommercePolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "InventoryReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FulfillmentGroup" ADD CONSTRAINT "FulfillmentGroup_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FulfillmentGroup" ADD CONSTRAINT "FulfillmentGroup_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FulfillmentGroupItem" ADD CONSTRAINT "FulfillmentGroupItem_fulfillmentGroupId_fkey" FOREIGN KEY ("fulfillmentGroupId") REFERENCES "FulfillmentGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FulfillmentGroupItem" ADD CONSTRAINT "FulfillmentGroupItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
