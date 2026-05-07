CREATE TABLE "service_agreement_consumption_templates" (
  "id" serial PRIMARY KEY,
  "service_agreement_id" integer NOT NULL REFERENCES "service_agreements"("id"),
  "business_id" integer NOT NULL REFERENCES "businesses"("id"),
  "location_id" integer NOT NULL REFERENCES "locations"("id"),
  "product_id" integer NOT NULL REFERENCES "products"("id"),
  "quantity_per_session" integer NOT NULL,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamp DEFAULT NOW(),
  "updated_at" timestamp DEFAULT NOW()
);
