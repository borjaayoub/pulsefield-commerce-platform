-- Forward-only Phase 3 catalog and inventory foundation.
-- Reversal is intentionally a separate forward migration because these tables
-- become historical commerce records once referenced by later slices.

-- CreateEnum
CREATE TYPE "CatalogLifecycle" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

CREATE TYPE "PriceBookVersionLifecycle" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

CREATE TYPE "WarehouseStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TYPE "InventoryMovementType" AS ENUM (
  'INITIAL_STOCK',
  'ADJUSTMENT',
  'RESERVED',
  'RESERVATION_RELEASED',
  'RESERVATION_COMMITTED',
  'FULFILLMENT_DECREMENT'
);

-- CreateTable
CREATE TABLE "Product" (
  "id" UUID NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" TEXT NOT NULL,
  "status" "CatalogLifecycle" NOT NULL DEFAULT 'DRAFT',
  "specificationSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  "specifications" JSONB NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Product_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Product_content_check" CHECK (
    length(btrim("name")) > 0
    AND length(btrim("description")) > 0
    AND "specificationSchemaVersion" > 0
    AND jsonb_typeof("specifications") = 'object'
  ),
  CONSTRAINT "Product_archival_check" CHECK (
    ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
    OR ("status" <> 'ARCHIVED' AND "archivedAt" IS NULL)
  )
);

CREATE TABLE "ProductSlug" (
  "id" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "slug" VARCHAR(160) NOT NULL,
  "isCanonical" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductSlug_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductSlug_format_check" CHECK (
    "slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  )
);

CREATE TABLE "ProductVariant" (
  "id" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "sku" VARCHAR(64) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "optionSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  "optionValues" JSONB NOT NULL,
  "weightGrams" INTEGER NOT NULL,
  "taxClass" VARCHAR(64) NOT NULL,
  "status" "CatalogLifecycle" NOT NULL DEFAULT 'DRAFT',
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductVariant_content_check" CHECK (
    length(btrim("name")) > 0
    AND "sku" ~ '^[A-Z0-9][A-Z0-9-]{2,63}$'
    AND "optionSchemaVersion" > 0
    AND "weightGrams" > 0
    AND "taxClass" ~ '^[a-z][a-z0-9.-]*$'
  ),
  CONSTRAINT "ProductVariant_options_check" CHECK (
    jsonb_typeof("optionValues") = 'object'
    AND "optionValues" ?& ARRAY['size', 'color']
    AND ("optionValues" - ARRAY['size', 'color']) = '{}'::jsonb
    AND jsonb_typeof("optionValues" -> 'size') = 'string'
    AND jsonb_typeof("optionValues" -> 'color') = 'string'
    AND length("optionValues" ->> 'size') BETWEEN 1 AND 32
    AND length("optionValues" ->> 'color') BETWEEN 1 AND 64
  ),
  CONSTRAINT "ProductVariant_archival_check" CHECK (
    ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
    OR ("status" <> 'ARCHIVED' AND "archivedAt" IS NULL)
  )
);

CREATE TABLE "Category" (
  "id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "slug" VARCHAR(120) NOT NULL,
  "status" "CatalogLifecycle" NOT NULL DEFAULT 'DRAFT',
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Category_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Category_content_check" CHECK (
    length(btrim("name")) > 0
    AND "slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  CONSTRAINT "Category_archival_check" CHECK (
    ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
    OR ("status" <> 'ARCHIVED' AND "archivedAt" IS NULL)
  )
);

CREATE TABLE "ProductCategory" (
  "productId" UUID NOT NULL,
  "categoryId" UUID NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("productId", "categoryId"),
  CONSTRAINT "ProductCategory_position_check" CHECK ("position" >= 0)
);

CREATE TABLE "ProductMedia" (
  "id" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "storageKey" VARCHAR(255) NOT NULL,
  "altText" VARCHAR(500) NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "status" "CatalogLifecycle" NOT NULL DEFAULT 'DRAFT',
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductMedia_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductMedia_content_check" CHECK (
    length(btrim("storageKey")) > 0
    AND left("storageKey", 1) <> '/'
    AND position('..' IN "storageKey") = 0
    AND position(E'\\\\' IN "storageKey") = 0
    AND length(btrim("altText")) > 0
    AND "width" > 0
    AND "height" > 0
    AND "position" >= 0
  ),
  CONSTRAINT "ProductMedia_archival_check" CHECK (
    ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
    OR ("status" <> 'ARCHIVED' AND "archivedAt" IS NULL)
  )
);

CREATE TABLE "PriceBook" (
  "id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "marketCode" CHAR(2) NOT NULL,
  "currencyCode" CHAR(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PriceBook_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PriceBook_content_check" CHECK (
    "code" ~ '^[A-Z0-9][A-Z0-9-]{2,63}$'
    AND length(btrim("name")) > 0
    AND "marketCode" ~ '^[A-Z]{2}$'
    AND "currencyCode" ~ '^[A-Z]{3}$'
  )
);

CREATE TABLE "PriceBookVersion" (
  "id" UUID NOT NULL,
  "priceBookId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "lifecycle" "PriceBookVersionLifecycle" NOT NULL DEFAULT 'DRAFT',
  "effectiveFrom" TIMESTAMP(3),
  "effectiveUntil" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PriceBookVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PriceBookVersion_metadata_check" CHECK (
    "version" > 0
    AND (
      ("lifecycle" = 'DRAFT' AND "effectiveFrom" IS NULL AND "effectiveUntil" IS NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL)
      OR ("lifecycle" = 'ACTIVE' AND "effectiveFrom" IS NOT NULL AND "effectiveUntil" IS NULL AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL)
      OR ("lifecycle" = 'RETIRED' AND "effectiveFrom" IS NOT NULL AND "effectiveUntil" IS NOT NULL AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL AND "effectiveUntil" >= "effectiveFrom" AND "retiredAt" >= "activatedAt")
    )
  )
);

CREATE TABLE "VariantPrice" (
  "id" UUID NOT NULL,
  "priceBookVersionId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VariantPrice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VariantPrice_amount_check" CHECK ("amountMinor" >= 0)
);

CREATE TABLE "Warehouse" (
  "id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "countryCode" CHAR(2) NOT NULL,
  "status" "WarehouseStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Warehouse_content_check" CHECK (
    "code" ~ '^[A-Z0-9][A-Z0-9-]{2,63}$'
    AND length(btrim("name")) > 0
    AND "countryCode" ~ '^[A-Z]{2}$'
  )
);

CREATE TABLE "InventoryBalance" (
  "id" UUID NOT NULL,
  "warehouseId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "onHand" INTEGER NOT NULL,
  "reserved" INTEGER NOT NULL DEFAULT 0,
  "allocated" INTEGER NOT NULL DEFAULT 0,
  "damaged" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryBalance_quantities_check" CHECK (
    "onHand" >= 0
    AND "reserved" >= 0
    AND "allocated" >= 0
    AND "damaged" >= 0
    AND "reserved" + "allocated" + "damaged" <= "onHand"
    AND "version" > 0
  )
);

CREATE TABLE "InventoryMovement" (
  "id" UUID NOT NULL,
  "warehouseId" UUID NOT NULL,
  "variantId" UUID NOT NULL,
  "type" "InventoryMovementType" NOT NULL,
  "onHandDelta" INTEGER NOT NULL DEFAULT 0,
  "reservedDelta" INTEGER NOT NULL DEFAULT 0,
  "allocatedDelta" INTEGER NOT NULL DEFAULT 0,
  "damagedDelta" INTEGER NOT NULL DEFAULT 0,
  "resultingOnHand" INTEGER NOT NULL,
  "resultingReserved" INTEGER NOT NULL,
  "resultingAllocated" INTEGER NOT NULL,
  "resultingDamaged" INTEGER NOT NULL,
  "commandId" UUID NOT NULL,
  "commandSequence" INTEGER NOT NULL DEFAULT 1,
  "actorType" "AuditActorType" NOT NULL,
  "actorId" VARCHAR(128) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryMovement_content_check" CHECK (
    "commandSequence" > 0
    AND length(btrim("actorId")) > 0
    AND length(btrim("reason")) > 0
    AND ("onHandDelta" <> 0 OR "reservedDelta" <> 0 OR "allocatedDelta" <> 0 OR "damagedDelta" <> 0)
  ),
  CONSTRAINT "InventoryMovement_resulting_quantities_check" CHECK (
    "resultingOnHand" >= 0
    AND "resultingReserved" >= 0
    AND "resultingAllocated" >= 0
    AND "resultingDamaged" >= 0
    AND "resultingReserved" + "resultingAllocated" + "resultingDamaged" <= "resultingOnHand"
  ),
  CONSTRAINT "InventoryMovement_previous_quantities_check" CHECK (
    "resultingOnHand" - "onHandDelta" >= 0
    AND "resultingReserved" - "reservedDelta" >= 0
    AND "resultingAllocated" - "allocatedDelta" >= 0
    AND "resultingDamaged" - "damagedDelta" >= 0
    AND ("resultingReserved" - "reservedDelta") + ("resultingAllocated" - "allocatedDelta") + ("resultingDamaged" - "damagedDelta") <= ("resultingOnHand" - "onHandDelta")
  ),
  CONSTRAINT "InventoryMovement_type_semantics_check" CHECK (
    ("type" = 'INITIAL_STOCK' AND "onHandDelta" > 0 AND "reservedDelta" = 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
    OR ("type" = 'ADJUSTMENT')
    OR ("type" = 'RESERVED' AND "onHandDelta" = 0 AND "reservedDelta" > 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
    OR ("type" = 'RESERVATION_RELEASED' AND "onHandDelta" = 0 AND "reservedDelta" < 0 AND "allocatedDelta" = 0 AND "damagedDelta" = 0)
    OR ("type" = 'RESERVATION_COMMITTED' AND "onHandDelta" = 0 AND "reservedDelta" < 0 AND "allocatedDelta" = -"reservedDelta" AND "damagedDelta" = 0)
    OR ("type" = 'FULFILLMENT_DECREMENT' AND "onHandDelta" < 0 AND "reservedDelta" = 0 AND "allocatedDelta" = "onHandDelta" AND "damagedDelta" = 0)
  )
);

-- CreateIndex
CREATE INDEX "Product_status_createdAt_idx" ON "Product"("status", "createdAt");
CREATE UNIQUE INDEX "ProductSlug_slug_key" ON "ProductSlug"("slug");
CREATE INDEX "ProductSlug_productId_isCanonical_idx" ON "ProductSlug"("productId", "isCanonical");
CREATE UNIQUE INDEX "ProductSlug_one_canonical_per_product" ON "ProductSlug"("productId") WHERE "isCanonical" = true;
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");
CREATE INDEX "ProductVariant_productId_status_idx" ON "ProductVariant"("productId", "status");
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");
CREATE INDEX "Category_status_name_idx" ON "Category"("status", "name");
CREATE INDEX "ProductCategory_categoryId_position_productId_idx" ON "ProductCategory"("categoryId", "position", "productId");
CREATE UNIQUE INDEX "ProductMedia_productId_storageKey_key" ON "ProductMedia"("productId", "storageKey");
CREATE UNIQUE INDEX "ProductMedia_productId_position_key" ON "ProductMedia"("productId", "position");
CREATE INDEX "ProductMedia_productId_status_position_idx" ON "ProductMedia"("productId", "status", "position");
CREATE UNIQUE INDEX "PriceBook_code_key" ON "PriceBook"("code");
CREATE UNIQUE INDEX "PriceBookVersion_priceBookId_version_key" ON "PriceBookVersion"("priceBookId", "version");
CREATE INDEX "PriceBookVersion_priceBookId_lifecycle_idx" ON "PriceBookVersion"("priceBookId", "lifecycle");
CREATE UNIQUE INDEX "PriceBookVersion_one_active_per_price_book" ON "PriceBookVersion"("priceBookId") WHERE "lifecycle" = 'ACTIVE';
CREATE UNIQUE INDEX "VariantPrice_priceBookVersionId_variantId_key" ON "VariantPrice"("priceBookVersionId", "variantId");
CREATE INDEX "VariantPrice_variantId_priceBookVersionId_idx" ON "VariantPrice"("variantId", "priceBookVersionId");
CREATE UNIQUE INDEX "Warehouse_code_key" ON "Warehouse"("code");
CREATE INDEX "Warehouse_status_countryCode_idx" ON "Warehouse"("status", "countryCode");
CREATE UNIQUE INDEX "InventoryBalance_warehouseId_variantId_key" ON "InventoryBalance"("warehouseId", "variantId");
CREATE INDEX "InventoryBalance_variantId_warehouseId_idx" ON "InventoryBalance"("variantId", "warehouseId");
CREATE UNIQUE INDEX "InventoryMovement_commandId_commandSequence_key" ON "InventoryMovement"("commandId", "commandSequence");
CREATE INDEX "InventoryMovement_warehouseId_variantId_occurredAt_idx" ON "InventoryMovement"("warehouseId", "variantId", "occurredAt");
CREATE INDEX "InventoryMovement_variantId_occurredAt_idx" ON "InventoryMovement"("variantId", "occurredAt");

-- AddForeignKey
ALTER TABLE "ProductSlug" ADD CONSTRAINT "ProductSlug_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceBookVersion" ADD CONSTRAINT "PriceBookVersion_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VariantPrice" ADD CONSTRAINT "VariantPrice_priceBookVersionId_fkey" FOREIGN KEY ("priceBookVersionId") REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VariantPrice" ADD CONSTRAINT "VariantPrice_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Active products must resolve through exactly one canonical slug at commit.
CREATE FUNCTION enforce_active_product_canonical_slug()
RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'ACTIVE'
    AND (SELECT count(*) FROM "ProductSlug" WHERE "productId" = NEW."id" AND "isCanonical" = true) <> 1
  THEN
    RAISE EXCEPTION 'active product must have exactly one canonical slug';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Product_active_canonical_slug"
AFTER INSERT OR UPDATE ON "Product"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_active_product_canonical_slug();

CREATE FUNCTION enforce_slug_owner_canonical_slug()
RETURNS trigger AS $$
DECLARE
  affected_product_id UUID;
BEGIN
  affected_product_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."productId" ELSE NEW."productId" END;
  IF EXISTS (SELECT 1 FROM "Product" WHERE "id" = affected_product_id AND "status" = 'ACTIVE')
    AND (SELECT count(*) FROM "ProductSlug" WHERE "productId" = affected_product_id AND "isCanonical" = true) <> 1
  THEN
    RAISE EXCEPTION 'active product must have exactly one canonical slug';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ProductSlug_owner_canonical_slug"
AFTER INSERT OR UPDATE OR DELETE ON "ProductSlug"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_slug_owner_canonical_slug();

-- Stable catalog identities remain historical; only lifecycle fields may change.
CREATE FUNCTION protect_product_slug_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW."productId" IS DISTINCT FROM OLD."productId"
    OR NEW."slug" IS DISTINCT FROM OLD."slug"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'product slug identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProductSlug_immutable_identity"
BEFORE UPDATE ON "ProductSlug"
FOR EACH ROW EXECUTE FUNCTION protect_product_slug_identity();

CREATE FUNCTION protect_product_variant_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW."productId" IS DISTINCT FROM OLD."productId"
    OR NEW."sku" IS DISTINCT FROM OLD."sku"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'product variant identity and SKU are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProductVariant_immutable_identity"
BEFORE UPDATE ON "ProductVariant"
FOR EACH ROW EXECUTE FUNCTION protect_product_variant_identity();

CREATE FUNCTION reject_catalog_entity_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'catalog and inventory entities must be retained or archived';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Product_retain" BEFORE DELETE ON "Product" FOR EACH ROW EXECUTE FUNCTION reject_catalog_entity_delete();
CREATE TRIGGER "ProductSlug_retain" BEFORE DELETE ON "ProductSlug" FOR EACH ROW EXECUTE FUNCTION reject_catalog_entity_delete();
CREATE TRIGGER "ProductVariant_retain" BEFORE DELETE ON "ProductVariant" FOR EACH ROW EXECUTE FUNCTION reject_catalog_entity_delete();
CREATE TRIGGER "Category_retain" BEFORE DELETE ON "Category" FOR EACH ROW EXECUTE FUNCTION reject_catalog_entity_delete();
CREATE TRIGGER "ProductMedia_retain" BEFORE DELETE ON "ProductMedia" FOR EACH ROW EXECUTE FUNCTION reject_catalog_entity_delete();
CREATE TRIGGER "PriceBook_retain" BEFORE DELETE ON "PriceBook" FOR EACH ROW EXECUTE FUNCTION reject_catalog_entity_delete();
CREATE TRIGGER "PriceBookVersion_retain" BEFORE DELETE ON "PriceBookVersion" FOR EACH ROW EXECUTE FUNCTION reject_catalog_entity_delete();
CREATE TRIGGER "Warehouse_retain" BEFORE DELETE ON "Warehouse" FOR EACH ROW EXECUTE FUNCTION reject_catalog_entity_delete();
CREATE TRIGGER "InventoryBalance_retain" BEFORE DELETE ON "InventoryBalance" FOR EACH ROW EXECUTE FUNCTION reject_catalog_entity_delete();

-- Price rows may change only while their immutable owning version is a draft.
CREATE FUNCTION protect_variant_price_history()
RETURNS trigger AS $$
DECLARE
  owning_lifecycle "PriceBookVersionLifecycle";
BEGIN
  SELECT "lifecycle" INTO owning_lifecycle
  FROM "PriceBookVersion"
  WHERE "id" = OLD."priceBookVersionId";

  IF owning_lifecycle IS DISTINCT FROM 'DRAFT'::"PriceBookVersionLifecycle" THEN
    RAISE EXCEPTION 'prices in active or retired price-book versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VariantPrice_protect_history"
BEFORE UPDATE OR DELETE ON "VariantPrice"
FOR EACH ROW EXECUTE FUNCTION protect_variant_price_history();

CREATE FUNCTION enforce_price_book_version_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW."priceBookId" IS DISTINCT FROM OLD."priceBookId"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'price-book version identity is immutable';
  END IF;

  IF OLD."lifecycle" = 'DRAFT' AND NEW."lifecycle" = 'ACTIVE' THEN
    IF NEW."effectiveFrom" IS NULL OR NEW."activatedAt" IS NULL OR NEW."effectiveUntil" IS NOT NULL OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'invalid price-book activation metadata';
    END IF;
  ELSIF OLD."lifecycle" = 'ACTIVE' AND NEW."lifecycle" = 'RETIRED' THEN
    IF NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
      OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
      OR NEW."effectiveUntil" IS NULL
      OR NEW."retiredAt" IS NULL
    THEN
      RAISE EXCEPTION 'invalid price-book retirement metadata';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid price-book version lifecycle transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PriceBookVersion_valid_transition"
BEFORE UPDATE ON "PriceBookVersion"
FOR EACH ROW EXECUTE FUNCTION enforce_price_book_version_transition();

-- Balance identity is stable and each optimistic revision advances exactly once.
CREATE FUNCTION enforce_inventory_balance_revision()
RETURNS trigger AS $$
BEGIN
  IF NEW."warehouseId" IS DISTINCT FROM OLD."warehouseId"
    OR NEW."variantId" IS DISTINCT FROM OLD."variantId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'inventory balance identity is immutable';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'inventory balance version must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "InventoryBalance_advance_revision"
BEFORE UPDATE ON "InventoryBalance"
FOR EACH ROW EXECUTE FUNCTION enforce_inventory_balance_revision();

CREATE FUNCTION reject_inventory_movement_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory movements are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "InventoryMovement_append_only"
BEFORE UPDATE OR DELETE ON "InventoryMovement"
FOR EACH ROW EXECUTE FUNCTION reject_inventory_movement_mutation();

-- A movement snapshot must agree with the materialized balance written in the
-- same transaction. Later command services remain responsible for updating the
-- balance and appending the movement atomically.
CREATE FUNCTION enforce_inventory_movement_balance_snapshot()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "InventoryBalance"
    WHERE "warehouseId" = NEW."warehouseId"
      AND "variantId" = NEW."variantId"
      AND "onHand" = NEW."resultingOnHand"
      AND "reserved" = NEW."resultingReserved"
      AND "allocated" = NEW."resultingAllocated"
      AND "damaged" = NEW."resultingDamaged"
  ) THEN
    RAISE EXCEPTION 'inventory movement snapshot must match the current balance';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "InventoryMovement_matches_balance"
BEFORE INSERT ON "InventoryMovement"
FOR EACH ROW EXECUTE FUNCTION enforce_inventory_movement_balance_snapshot();
