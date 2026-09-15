CREATE TABLE "GuestOrderAccessGrant" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "tokenDigest" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestOrderAccessGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GuestOrderAccessGrant_expiry_check"
      CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "GuestOrderAccessGrant_revocation_check"
      CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
);

CREATE UNIQUE INDEX "GuestOrderAccessGrant_orderId_key"
  ON "GuestOrderAccessGrant"("orderId");
CREATE UNIQUE INDEX "GuestOrderAccessGrant_tokenDigest_key"
  ON "GuestOrderAccessGrant"("tokenDigest");
CREATE INDEX "GuestOrderAccessGrant_expiresAt_idx"
  ON "GuestOrderAccessGrant"("expiresAt");

ALTER TABLE "GuestOrderAccessGrant"
  ADD CONSTRAINT "GuestOrderAccessGrant_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_guest_order_access_identity_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."tokenDigest" IS DISTINCT FROM OLD."tokenDigest"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'guest order access grant identity is immutable';
  END IF;

  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'guest order access revocation is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GuestOrderAccessGrant_immutable_identity"
BEFORE UPDATE ON "GuestOrderAccessGrant"
FOR EACH ROW EXECUTE FUNCTION reject_guest_order_access_identity_change();
