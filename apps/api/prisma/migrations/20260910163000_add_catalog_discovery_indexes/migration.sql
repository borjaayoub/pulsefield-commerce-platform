-- Slice 3.2: indexes for the bounded public discovery query shapes.
DROP INDEX IF EXISTS "Product_status_createdAt_idx";
DROP INDEX IF EXISTS "ProductVariant_productId_status_idx";

CREATE INDEX "Product_status_createdAt_id_idx"
  ON "Product"("status", "createdAt", "id");

CREATE INDEX "Product_status_name_id_idx"
  ON "Product"("status", "name", "id");

CREATE INDEX "ProductVariant_productId_status_id_idx"
  ON "ProductVariant"("productId", "status", "id");
