BEGIN;
ALTER TABLE "Cart" ADD COLUMN "marketCode" CHAR(2) NOT NULL DEFAULT 'US';
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_market_check" CHECK ("marketCode" IN ('US','MA','EU','UK'));
CREATE FUNCTION protect_cart_market_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."marketCode" IS DISTINCT FROM OLD."marketCode" AND
    (OLD."status" <> 'OPEN' OR NEW."status" <> 'OPEN' OR NEW."revision" <> OLD."revision" + 1) THEN
    RAISE EXCEPTION 'cart market changes require an open cart and one revision advance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "Cart_market_selection_guard" BEFORE UPDATE ON "Cart"
FOR EACH ROW EXECUTE FUNCTION protect_cart_market_selection();
COMMIT;
