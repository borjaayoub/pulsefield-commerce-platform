-- Slice 3.2: support the case-insensitive substring search used by the
-- public catalog query. The local PostgreSQL image ships pg_trgm in contrib.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Product_name_trgm_idx"
  ON "Product" USING GIN ("name" gin_trgm_ops);

CREATE INDEX "Product_description_trgm_idx"
  ON "Product" USING GIN ("description" gin_trgm_ops);
