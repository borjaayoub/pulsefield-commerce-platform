BEGIN;
CREATE TABLE "CommerceMarket" (
  "id" UUID NOT NULL PRIMARY KEY, "code" CHAR(2) NOT NULL UNIQUE,
  "currencyCode" CHAR(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommerceMarket_pair_check" CHECK (
    ("code", "currencyCode") IN (('US','USD'),('MA','MAD'),('EU','EUR'),('UK','GBP')))
);
CREATE TABLE "CommerceMarketVersion" (
  "id" UUID NOT NULL PRIMARY KEY, "marketId" UUID NOT NULL REFERENCES "CommerceMarket"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "lifecycle" "CommercePolicyLifecycle" NOT NULL DEFAULT 'DRAFT',
  "effectiveFrom" TIMESTAMP(3) NOT NULL, "activatedAt" TIMESTAMP(3), "retiredAt" TIMESTAMP(3),
  "countryCodes" TEXT[] NOT NULL,
  "priceBookVersionId" UUID NOT NULL REFERENCES "PriceBookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "allocationPolicyVersionId" UUID NOT NULL REFERENCES "InventoryAllocationPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "calculationVersion" VARCHAR(64) NOT NULL CHECK ("calculationVersion" = 'international-commerce-v1'),
  "taxCalculationId" VARCHAR(128) NOT NULL CHECK ("taxCalculationId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "shippingCalculationId" VARCHAR(128) NOT NULL CHECK ("shippingCalculationId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "taxTreatment" VARCHAR(16) NOT NULL CHECK ("taxTreatment" = 'exclusive'),
  "taxRateBasisPoints" INTEGER NOT NULL CHECK ("taxRateBasisPoints" BETWEEN 0 AND 10000),
  "shippingBaseMinor" INTEGER NOT NULL CHECK ("shippingBaseMinor" >= 0),
  "freeShippingThresholdMinor" INTEGER NOT NULL CHECK ("freeShippingThresholdMinor" >= 0),
  "heavyThresholdGrams" INTEGER NOT NULL CHECK ("heavyThresholdGrams" >= 0),
  "heavySurchargeBasisPoints" INTEGER NOT NULL CHECK ("heavySurchargeBasisPoints" BETWEEN 0 AND 10000),
  "reservationDurationSeconds" INTEGER NOT NULL CHECK ("reservationDurationSeconds" BETWEEN 1 AND 86400),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommerceMarketVersion_metadata_check" CHECK (
    ("lifecycle" = 'DRAFT' AND "activatedAt" IS NULL AND "retiredAt" IS NULL) OR
    ("lifecycle" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL AND "effectiveFrom" <= "activatedAt") OR
    ("lifecycle" = 'RETIRED' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL AND "retiredAt" >= "activatedAt" AND "effectiveFrom" <= "activatedAt")),
  UNIQUE ("marketId", "version")
);
CREATE UNIQUE INDEX "CommerceMarketVersion_one_active" ON "CommerceMarketVersion"("marketId") WHERE "lifecycle" = 'ACTIVE';
CREATE INDEX "CommerceMarketVersion_marketId_lifecycle_idx" ON "CommerceMarketVersion"("marketId", "lifecycle");
CREATE TABLE "ReportingRateVersion" (
  "id" UUID NOT NULL PRIMARY KEY, "sourceCurrency" CHAR(3) NOT NULL, "targetCurrency" CHAR(3) NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "numerator" BIGINT NOT NULL CHECK ("numerator" BETWEEN 1 AND 9007199254740991),
  "denominator" BIGINT NOT NULL CHECK ("denominator" BETWEEN 1 AND 9007199254740991),
  "sourceNote" VARCHAR(160) NOT NULL CHECK ("sourceNote" ~ '^[A-Za-z0-9][A-Za-z0-9 /._:-]{0,159}$'),
  "effectiveFrom" TIMESTAMP(3) NOT NULL, "freshUntil" TIMESTAMP(3) NOT NULL,
  "publishedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReportingRateVersion_pair_check" CHECK ("sourceCurrency" IN ('USD','MAD','EUR','GBP') AND "targetCurrency" = 'USD'),
  CONSTRAINT "ReportingRateVersion_identity_check" CHECK ("sourceCurrency" <> 'USD' OR "numerator" = "denominator"),
  CONSTRAINT "ReportingRateVersion_freshness_check" CHECK ("freshUntil" > "effectiveFrom"),
  UNIQUE ("sourceCurrency", "targetCurrency", "revision")
);
CREATE INDEX "ReportingRateVersion_sourceCurrency_targetCurrency_effectiveFrom_idx" ON "ReportingRateVersion"("sourceCurrency", "targetCurrency", "effectiveFrom");
CREATE UNIQUE INDEX "ReportingRateVersion_published_effective" ON "ReportingRateVersion"("sourceCurrency", "targetCurrency", "effectiveFrom") WHERE "publishedAt" IS NOT NULL;

CREATE FUNCTION protect_commerce_market() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce market identity is immutable' USING ERRCODE = '23514';
END; $$;
CREATE TRIGGER "CommerceMarket_identity" BEFORE UPDATE OR DELETE ON "CommerceMarket" FOR EACH ROW EXECUTE FUNCTION protect_commerce_market();

CREATE FUNCTION validate_commerce_market_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE market_code TEXT; market_currency TEXT; allowed TEXT[]; canonical TEXT[];
DECLARE book_market TEXT; book_currency TEXT; book_lifecycle TEXT; route_region TEXT; route_lifecycle TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."lifecycle" <> 'DRAFT' THEN RAISE EXCEPTION 'commerce market history is immutable' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  SELECT "code", "currencyCode" INTO market_code, market_currency FROM "CommerceMarket" WHERE "id" = NEW."marketId" FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF NEW."lifecycle" <> 'DRAFT' THEN RAISE EXCEPTION 'market versions must begin as drafts' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."marketId" IS DISTINCT FROM OLD."marketId" OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'market version identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD."lifecycle" = 'RETIRED' THEN RAISE EXCEPTION 'retired market history is immutable' USING ERRCODE = '23514'; END IF;
    IF OLD."lifecycle" = 'ACTIVE' THEN
      IF NEW."lifecycle" <> 'RETIRED' OR
        (to_jsonb(NEW) - 'lifecycle' - 'retiredAt') IS DISTINCT FROM (to_jsonb(OLD) - 'lifecycle' - 'retiredAt') THEN
        RAISE EXCEPTION 'active market values are immutable' USING ERRCODE = '23514';
      END IF;
      NEW."retiredAt" := CURRENT_TIMESTAMP;
      RETURN NEW;
    END IF;
    IF NEW."lifecycle" = 'RETIRED' THEN RAISE EXCEPTION 'draft market cannot retire' USING ERRCODE = '23514'; END IF;
  END IF;
  allowed := CASE market_code WHEN 'US' THEN ARRAY['US'] WHEN 'MA' THEN ARRAY['MA'] WHEN 'UK' THEN ARRAY['GB']
    WHEN 'EU' THEN ARRAY['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'] END;
  SELECT array_agg(DISTINCT c COLLATE "C" ORDER BY c COLLATE "C") INTO canonical FROM unnest(NEW."countryCodes") c;
  IF canonical IS NULL OR NEW."countryCodes" IS DISTINCT FROM canonical OR NOT NEW."countryCodes" <@ allowed OR array_position(NEW."countryCodes", NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'market destination membership is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW."lifecycle" = 'ACTIVE' THEN
    IF NEW."effectiveFrom" > CURRENT_TIMESTAMP OR EXISTS (SELECT 1 FROM "CommerceMarketVersion" WHERE "marketId" = NEW."marketId" AND "activatedAt" IS NOT NULL AND "version" >= NEW."version") THEN
      RAISE EXCEPTION 'market activation version or effective time is invalid' USING ERRCODE = '23514';
    END IF;
    -- Lock dependencies in a fixed order against concurrent retirement/identity changes.
    PERFORM 1 FROM "PriceBook" b JOIN "PriceBookVersion" v ON v."priceBookId" = b."id" WHERE v."id" = NEW."priceBookVersionId" FOR UPDATE OF b;
    SELECT b."marketCode", b."currencyCode", v."lifecycle"::TEXT INTO book_market, book_currency, book_lifecycle
      FROM "PriceBookVersion" v JOIN "PriceBook" b ON b."id" = v."priceBookId" WHERE v."id" = NEW."priceBookVersionId" FOR UPDATE OF v;
    PERFORM 1 FROM "InventoryAllocationPolicy" p JOIN "InventoryAllocationPolicyVersion" v ON v."policyId" = p."id" WHERE v."id" = NEW."allocationPolicyVersionId" FOR UPDATE OF p;
    SELECT p."destinationRegion"::TEXT, v."lifecycle"::TEXT INTO route_region, route_lifecycle
      FROM "InventoryAllocationPolicyVersion" v JOIN "InventoryAllocationPolicy" p ON p."id" = v."policyId" WHERE v."id" = NEW."allocationPolicyVersionId" FOR UPDATE OF v;
    IF book_market IS DISTINCT FROM market_code OR book_currency IS DISTINCT FROM market_currency OR book_lifecycle IS DISTINCT FROM 'ACTIVE' OR route_lifecycle IS DISTINCT FROM 'ACTIVE' OR
      route_region IS DISTINCT FROM (CASE market_code WHEN 'US' THEN 'US' WHEN 'MA' THEN 'MOROCCO' ELSE 'EU' END) THEN
      RAISE EXCEPTION 'market dependencies are invalid' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "ProductVariant" variant JOIN "Product" product ON product."id" = variant."productId"
      WHERE variant."status" = 'ACTIVE' AND product."status" = 'ACTIVE' AND NOT EXISTS
      (SELECT 1 FROM "VariantPrice" price WHERE price."variantId" = variant."id" AND price."priceBookVersionId" = NEW."priceBookVersionId")) THEN
      RAISE EXCEPTION 'market price coverage is incomplete' USING ERRCODE = '23514';
    END IF;
    NEW."activatedAt" := CURRENT_TIMESTAMP;
    NEW."retiredAt" := NULL;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "CommerceMarketVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CommerceMarketVersion" FOR EACH ROW EXECUTE FUNCTION validate_commerce_market_version();

CREATE FUNCTION protect_international_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'PriceBook' THEN
    IF EXISTS (SELECT 1 FROM "CommerceMarketVersion" m JOIN "PriceBookVersion" v ON v."id" = m."priceBookVersionId" WHERE v."priceBookId" = OLD."id" AND m."lifecycle" IN ('ACTIVE','RETIRED')) AND
      (NEW."id" IS DISTINCT FROM OLD."id" OR NEW."marketCode" IS DISTINCT FROM OLD."marketCode" OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode" OR NEW."code" IS DISTINCT FROM OLD."code") THEN
      RAISE EXCEPTION 'referenced market price book identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'PriceBookVersion' THEN
    IF EXISTS (SELECT 1 FROM "CommerceMarketVersion" WHERE "priceBookVersionId" = OLD."id" AND "lifecycle" = 'ACTIVE') AND
      (NEW."lifecycle" IS DISTINCT FROM OLD."lifecycle" OR NEW."priceBookId" IS DISTINCT FROM OLD."priceBookId") THEN
      RAISE EXCEPTION 'active market price dependency is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'InventoryAllocationPolicyVersion' THEN
    IF EXISTS (SELECT 1 FROM "CommerceMarketVersion" WHERE "allocationPolicyVersionId" = OLD."id" AND "lifecycle" = 'ACTIVE') AND NEW."lifecycle" IS DISTINCT FROM OLD."lifecycle" THEN
      RAISE EXCEPTION 'active market allocation dependency is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "PriceBook_market_guard" BEFORE UPDATE ON "PriceBook" FOR EACH ROW EXECUTE FUNCTION protect_international_dependencies();
CREATE TRIGGER "PriceBookVersion_market_guard" BEFORE UPDATE ON "PriceBookVersion" FOR EACH ROW EXECUTE FUNCTION protect_international_dependencies();
CREATE TRIGGER "InventoryAllocationPolicyVersion_market_guard" BEFORE UPDATE ON "InventoryAllocationPolicyVersion" FOR EACH ROW EXECUTE FUNCTION protect_international_dependencies();

CREATE FUNCTION protect_reporting_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."publishedAt" IS NOT NULL THEN RAISE EXCEPTION 'rates must begin unpublished' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."publishedAt" IS NOT NULL THEN RAISE EXCEPTION 'published reporting rates are immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'rate identity is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW."publishedAt" IS NOT NULL THEN NEW."publishedAt" := CURRENT_TIMESTAMP; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "ReportingRateVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReportingRateVersion" FOR EACH ROW EXECUTE FUNCTION protect_reporting_rate();
COMMIT;
