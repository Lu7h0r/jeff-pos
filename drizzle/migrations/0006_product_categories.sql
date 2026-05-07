CREATE TABLE IF NOT EXISTS "product_categories" (
  "id" serial PRIMARY KEY,
  "business_id" integer NOT NULL,
  "name" varchar(50) NOT NULL,
  "created_at" timestamp DEFAULT NOW(),
  CONSTRAINT "product_categories_business_id_fk"
    FOREIGN KEY ("business_id")
    REFERENCES "businesses"("id")
);

CREATE INDEX IF NOT EXISTS "product_categories_business_idx"
  ON "product_categories" ("business_id");

CREATE UNIQUE INDEX IF NOT EXISTS "product_categories_business_name_uidx"
  ON "product_categories" ("business_id", "name");
