ALTER TYPE "NotificationDeliveryType" ADD VALUE 'ORDER_CONFIRMATION';

ALTER TABLE "Order"
  ADD COLUMN "customerEmailNormalized" VARCHAR(255);

ALTER TABLE "NotificationDelivery"
  ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN "orderId" UUID;

ALTER TABLE "NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NotificationDelivery_exactly_one_owner_check"
  CHECK (("userId" IS NOT NULL)::integer + ("orderId" IS NOT NULL)::integer = 1);

CREATE INDEX "NotificationDelivery_orderId_queuedAt_idx"
  ON "NotificationDelivery"("orderId", "queuedAt");

CREATE FUNCTION "enforce_new_order_contact_email"() RETURNS trigger AS $$
BEGIN
  IF NEW."customerEmailNormalized" IS NULL
     OR NEW."customerEmailNormalized" <> lower(btrim(NEW."customerEmailNormalized"))
     OR length(NEW."customerEmailNormalized") < 3
     OR position('@' IN NEW."customerEmailNormalized") <= 1 THEN
    RAISE EXCEPTION 'new orders require a normalized contact email';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Order_contact_email_insert_guard"
BEFORE INSERT ON "Order"
FOR EACH ROW EXECUTE FUNCTION "enforce_new_order_contact_email"();

CREATE OR REPLACE FUNCTION "enforce_order_state_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'PENDING_PAYMENT' AND NEW."status" IN ('CONFIRMED', 'MANUAL_RESOLUTION')) THEN
    RAISE EXCEPTION 'invalid order status transition';
  END IF;
  IF NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."cartId" IS DISTINCT FROM OLD."cartId"
     OR NEW."policyVersionId" IS DISTINCT FROM OLD."policyVersionId"
     OR NEW."priceBookVersionId" IS DISTINCT FROM OLD."priceBookVersionId"
     OR NEW."reservationId" IS DISTINCT FROM OLD."reservationId"
     OR (NEW."recoveryReservationId" IS DISTINCT FROM OLD."recoveryReservationId"
       AND NOT (OLD."recoveryReservationId" IS NULL AND NEW."recoveryReservationId" IS NOT NULL
         AND OLD."status" = 'PENDING_PAYMENT' AND NEW."status" = 'CONFIRMED'))
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."subtotalMinor" IS DISTINCT FROM OLD."subtotalMinor"
     OR NEW."shippingMinor" IS DISTINCT FROM OLD."shippingMinor"
     OR NEW."taxMinor" IS DISTINCT FROM OLD."taxMinor"
     OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor"
     OR NEW."calculationSnapshot" IS DISTINCT FROM OLD."calculationSnapshot"
     OR NEW."shippingAddressSnapshot" IS DISTINCT FROM OLD."shippingAddressSnapshot"
     OR NEW."customerEmailNormalized" IS DISTINCT FROM OLD."customerEmailNormalized" THEN
    RAISE EXCEPTION 'order history is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
