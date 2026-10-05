-- Preserve all historical rows; require complete regional evidence on new orders.
ALTER TABLE "Order"
  ALTER COLUMN "policyVersionId" DROP NOT NULL,
  ADD COLUMN "commerceMarketVersionId" UUID,
  ADD COLUMN "reportingRateVersionId" UUID,
  ADD COLUMN "reportingSubtotalMinor" BIGINT,
  ADD COLUMN "reportingShippingMinor" BIGINT,
  ADD COLUMN "reportingTaxMinor" BIGINT,
  ADD COLUMN "reportingTotalMinor" BIGINT,
  ADD COLUMN "reportingRoundingAdjustmentMinor" BIGINT,
  ADD CONSTRAINT "Order_commerceMarketVersionId_fkey" FOREIGN KEY ("commerceMarketVersionId") REFERENCES "CommerceMarketVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Order_reportingRateVersionId_fkey" FOREIGN KEY ("reportingRateVersionId") REFERENCES "ReportingRateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Order_evidence_mode_check" CHECK (
    ("policyVersionId" IS NOT NULL AND num_nonnulls("commerceMarketVersionId", "reportingRateVersionId", "reportingSubtotalMinor", "reportingShippingMinor", "reportingTaxMinor", "reportingTotalMinor", "reportingRoundingAdjustmentMinor") = 0)
    OR ("policyVersionId" IS NULL AND num_nonnulls("commerceMarketVersionId", "reportingRateVersionId", "reportingSubtotalMinor", "reportingShippingMinor", "reportingTaxMinor", "reportingTotalMinor", "reportingRoundingAdjustmentMinor") = 7)
  ),
  ADD CONSTRAINT "Order_reporting_total_check" CHECK (
    "reportingTotalMinor" IS NULL OR (
      "reportingSubtotalMinor" BETWEEN 0 AND 9007199254740991 AND "reportingShippingMinor" BETWEEN 0 AND 9007199254740991
      AND "reportingTaxMinor" BETWEEN 0 AND 9007199254740991 AND "reportingTotalMinor" BETWEEN 0 AND 9007199254740991
      AND "reportingRoundingAdjustmentMinor" BETWEEN -9007199254740991 AND 9007199254740991
      AND "reportingTotalMinor"::numeric = "reportingSubtotalMinor"::numeric + "reportingShippingMinor" + "reportingTaxMinor" + "reportingRoundingAdjustmentMinor"
    )
  );
ALTER TABLE "Order" DROP CONSTRAINT "Order_currency_total_check";
ALTER TABLE "Order" ADD CONSTRAINT "Order_currency_total_check" CHECK (
  "currencyCode" IN ('USD', 'MAD', 'EUR', 'GBP') AND ("policyVersionId" IS NULL OR "currencyCode" = 'USD')
  AND "subtotalMinor" BETWEEN 0 AND 9007199254740991 AND "shippingMinor" BETWEEN 0 AND 9007199254740991
  AND "taxMinor" BETWEEN 0 AND 9007199254740991 AND "totalMinor" BETWEEN 0 AND 9007199254740991
  AND "totalMinor"::numeric = "subtotalMinor"::numeric + "shippingMinor" + "taxMinor"
);
ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_currency_amount_check";
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_currency_amount_check" CHECK (
  "currencyCode" IN ('USD', 'MAD', 'EUR', 'GBP') AND "amountMinor" BETWEEN 0 AND 9007199254740991 AND ("provider" <> 'stripe' OR "currencyCode" = 'USD')
);

CREATE FUNCTION "protect_regional_order_evidence"() RETURNS trigger AS $$
BEGIN
  IF (NEW."commerceMarketVersionId", NEW."reportingRateVersionId", NEW."reportingSubtotalMinor", NEW."reportingShippingMinor", NEW."reportingTaxMinor", NEW."reportingTotalMinor", NEW."reportingRoundingAdjustmentMinor")
    IS DISTINCT FROM (OLD."commerceMarketVersionId", OLD."reportingRateVersionId", OLD."reportingSubtotalMinor", OLD."reportingShippingMinor", OLD."reportingTaxMinor", OLD."reportingTotalMinor", OLD."reportingRoundingAdjustmentMinor") THEN
    RAISE EXCEPTION 'regional order evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Order_regional_evidence_immutable" BEFORE UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION "protect_regional_order_evidence"();

CREATE FUNCTION "check_regional_order_insert"() RETURNS trigger AS $$
DECLARE config "CommerceMarketVersion"%ROWTYPE;
DECLARE market "CommerceMarket"%ROWTYPE;
DECLARE rate "ReportingRateVersion"%ROWTYPE;
DECLARE evidence JSONB;
BEGIN
  IF NEW."commerceMarketVersionId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO config FROM "CommerceMarketVersion" WHERE "id" = NEW."commerceMarketVersionId" FOR SHARE;
  SELECT * INTO market FROM "CommerceMarket" WHERE "id" = config."marketId" FOR SHARE;
  SELECT * INTO rate FROM "ReportingRateVersion" WHERE "id" = NEW."reportingRateVersionId" FOR SHARE;
  evidence := NEW."calculationSnapshot";
  IF config."lifecycle" IS DISTINCT FROM 'ACTIVE' OR config."effectiveFrom" > CURRENT_TIMESTAMP
    OR NEW."currencyCode" IS DISTINCT FROM market."currencyCode" OR NEW."priceBookVersionId" IS DISTINCT FROM config."priceBookVersionId"
    OR NOT COALESCE(NEW."shippingAddressSnapshot"->>'countryCode' = ANY(config."countryCodes"), FALSE)
    OR (SELECT "marketCode" FROM "Cart" WHERE "id" = NEW."cartId") IS DISTINCT FROM market."code"
    OR (SELECT "allocationPolicyVersionId" FROM "InventoryReservation" WHERE "id" = NEW."reservationId") IS DISTINCT FROM config."allocationPolicyVersionId"
    OR (SELECT "lifecycle"::text FROM "PriceBookVersion" WHERE "id" = config."priceBookVersionId") IS DISTINCT FROM 'ACTIVE'
    OR (SELECT "lifecycle"::text FROM "InventoryAllocationPolicyVersion" WHERE "id" = config."allocationPolicyVersionId") IS DISTINCT FROM 'ACTIVE'
    OR rate."sourceCurrency" IS DISTINCT FROM market."currencyCode" OR rate."targetCurrency" IS DISTINCT FROM 'USD'
    OR rate."publishedAt" IS NULL OR rate."publishedAt" > CURRENT_TIMESTAMP OR rate."effectiveFrom" > CURRENT_TIMESTAMP
    OR rate."id" IS DISTINCT FROM (SELECT "id" FROM "ReportingRateVersion" WHERE "sourceCurrency" = market."currencyCode" AND "targetCurrency" = 'USD' AND "publishedAt" <= CURRENT_TIMESTAMP AND "effectiveFrom" <= CURRENT_TIMESTAMP ORDER BY "effectiveFrom" DESC, "revision" DESC LIMIT 1)
    OR evidence->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR evidence->'version' IS DISTINCT FROM '1'::jsonb
    OR evidence->>'market' IS DISTINCT FROM market."code"::text OR evidence->>'currency' IS DISTINCT FROM market."currencyCode"::text
    OR evidence->>'countryCode' IS DISTINCT FROM NEW."shippingAddressSnapshot"->>'countryCode'
    OR evidence->>'priceBookVersionId' IS DISTINCT FROM NEW."priceBookVersionId"::text
    OR evidence->'priceBookVersion' IS DISTINCT FROM to_jsonb((SELECT "version" FROM "PriceBookVersion" WHERE "id" = config."priceBookVersionId"))
    OR evidence->>'allocationPolicyVersionId' IS DISTINCT FROM config."allocationPolicyVersionId"::text
    OR evidence->'reservationDurationSeconds' IS DISTINCT FROM to_jsonb(config."reservationDurationSeconds")
    OR NOT COALESCE(evidence->>'pricingFingerprint' ~ '^[A-Za-z0-9_-]{43}$', FALSE)
    OR evidence->'policy' IS DISTINCT FROM jsonb_build_object(
      'configurationId', config."id", 'configurationVersion', config."version", 'calculationVersion', config."calculationVersion",
      'taxCalculationId', config."taxCalculationId", 'shippingCalculationId', config."shippingCalculationId", 'taxTreatment', config."taxTreatment",
      'taxRateBasisPoints', config."taxRateBasisPoints", 'shippingBaseMinor', config."shippingBaseMinor", 'freeShippingThresholdMinor', config."freeShippingThresholdMinor",
      'heavyThresholdGrams', config."heavyThresholdGrams", 'heavySurchargeBasisPoints', config."heavySurchargeBasisPoints")
    OR evidence#>'{reporting,rate}' IS DISTINCT FROM jsonb_build_object(
      'revisionId', rate."id", 'revision', rate."revision", 'sourceCurrency', rate."sourceCurrency", 'targetCurrency', rate."targetCurrency",
      'numerator', rate."numerator", 'denominator', rate."denominator", 'sourceNote', rate."sourceNote",
      'effectiveFrom', to_char(rate."effectiveFrom", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'freshUntil', to_char(rate."freshUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'staleFallback', CURRENT_TIMESTAMP >= rate."freshUntil")
    OR evidence#>>'{reporting,calculationVersion}' IS DISTINCT FROM 'usd-reporting-v1' OR evidence#>>'{reporting,currency}' IS DISTINCT FROM 'USD'
    OR evidence->'subtotalMinor' IS DISTINCT FROM to_jsonb(NEW."subtotalMinor") OR evidence->'shippingMinor' IS DISTINCT FROM to_jsonb(NEW."shippingMinor")
    OR evidence->'taxMinor' IS DISTINCT FROM to_jsonb(NEW."taxMinor") OR evidence->'totalMinor' IS DISTINCT FROM to_jsonb(NEW."totalMinor")
    OR evidence#>'{reporting,subtotalMinor}' IS DISTINCT FROM to_jsonb(NEW."reportingSubtotalMinor") OR evidence#>'{reporting,shippingMinor}' IS DISTINCT FROM to_jsonb(NEW."reportingShippingMinor")
    OR evidence#>'{reporting,taxMinor}' IS DISTINCT FROM to_jsonb(NEW."reportingTaxMinor") OR evidence#>'{reporting,totalMinor}' IS DISTINCT FROM to_jsonb(NEW."reportingTotalMinor")
    OR evidence#>'{reporting,roundingAdjustmentMinor}' IS DISTINCT FROM to_jsonb(NEW."reportingRoundingAdjustmentMinor")
    OR NEW."reportingSubtotalMinor" <> floor((NEW."subtotalMinor"::numeric * rate."numerator" * 2 + rate."denominator") / (2 * rate."denominator"))
    OR NEW."reportingShippingMinor" <> floor((NEW."shippingMinor"::numeric * rate."numerator" * 2 + rate."denominator") / (2 * rate."denominator"))
    OR NEW."reportingTaxMinor" <> floor((NEW."taxMinor"::numeric * rate."numerator" * 2 + rate."denominator") / (2 * rate."denominator"))
    OR NEW."reportingTotalMinor" <> floor((NEW."totalMinor"::numeric * rate."numerator" * 2 + rate."denominator") / (2 * rate."denominator")) THEN
    RAISE EXCEPTION 'regional order requires matching immutable evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Order_regional_insert_guard" BEFORE INSERT ON "Order" FOR EACH ROW EXECUTE FUNCTION "check_regional_order_insert"();

CREATE FUNCTION "check_regional_order_lines"() RETURNS trigger AS $$
DECLARE purchase "Order"%ROWTYPE;
DECLARE config "CommerceMarketVersion"%ROWTYPE;
DECLARE subtotal NUMERIC; DECLARE tax NUMERIC; DECLARE weight NUMERIC; DECLARE shipping NUMERIC; DECLARE surcharge NUMERIC; DECLARE line_evidence JSONB;
BEGIN
  IF TG_TABLE_NAME = 'Order' THEN SELECT * INTO purchase FROM "Order" WHERE "id" = NEW."id";
  ELSE SELECT * INTO purchase FROM "Order" WHERE "id" = NEW."orderId"; END IF;
  IF purchase."commerceMarketVersionId" IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO config FROM "CommerceMarketVersion" WHERE "id" = purchase."commerceMarketVersionId";
  IF NOT EXISTS (SELECT 1 FROM "OrderLine" WHERE "orderId" = purchase."id") OR EXISTS (
    SELECT 1 FROM "OrderLine" l LEFT JOIN "VariantPrice" p ON p."variantId" = l."variantId" AND p."priceBookVersionId" = purchase."priceBookVersionId"
    WHERE l."orderId" = purchase."id" AND (p."amountMinor" IS DISTINCT FROM l."unitPriceMinor"
      OR l."lineSubtotalMinor"::numeric <> l."unitPriceMinor"::numeric * l."quantity"
      OR l."lineTaxMinor" <> floor((l."lineSubtotalMinor"::numeric * config."taxRateBasisPoints" * 2 + 10000) / 20000)
      OR l."lineTotalMinor"::numeric <> l."lineSubtotalMinor"::numeric + l."lineTaxMinor")
  ) THEN RAISE EXCEPTION 'regional order line calculation mismatch'; END IF;
  SELECT sum("lineSubtotalMinor"::numeric), sum("lineTaxMinor"::numeric), sum("weightGramsSnapshot"::numeric * "quantity"),
    jsonb_agg(jsonb_build_object('variantId', "variantId", 'currency', purchase."currencyCode", 'quantity', "quantity", 'unitPriceMinor', "unitPriceMinor", 'weightGrams', "weightGramsSnapshot", 'subtotalMinor', "lineSubtotalMinor", 'taxMinor', "lineTaxMinor", 'totalMinor', "lineTotalMinor") ORDER BY "variantId")
    INTO subtotal, tax, weight, line_evidence FROM "OrderLine" WHERE "orderId" = purchase."id";
  surcharge := CASE WHEN weight > config."heavyThresholdGrams" THEN floor((config."shippingBaseMinor"::numeric * config."heavySurchargeBasisPoints" * 2 + 10000) / 20000) ELSE 0 END;
  shipping := CASE WHEN subtotal >= config."freeShippingThresholdMinor" THEN 0 ELSE config."shippingBaseMinor" END;
  IF subtotal <> purchase."subtotalMinor" OR tax <> purchase."taxMinor" OR shipping + surcharge <> purchase."shippingMinor"
    OR purchase."calculationSnapshot"->'totalWeightGrams' IS DISTINCT FROM to_jsonb(weight)
    OR purchase."calculationSnapshot"->'payableBaseShippingMinor' IS DISTINCT FROM to_jsonb(shipping)
    OR purchase."calculationSnapshot"->'heavySurchargeMinor' IS DISTINCT FROM to_jsonb(surcharge)
    OR purchase."calculationSnapshot"->'lines' IS DISTINCT FROM line_evidence THEN
    RAISE EXCEPTION 'regional order totals or line evidence mismatch';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "Order_regional_lines_guard" AFTER INSERT ON "Order" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_regional_order_lines"();
CREATE CONSTRAINT TRIGGER "OrderLine_regional_calculation_guard" AFTER INSERT ON "OrderLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_regional_order_lines"();
