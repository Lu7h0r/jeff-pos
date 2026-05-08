CREATE TABLE IF NOT EXISTS "bookings" (
  "id" serial PRIMARY KEY,
  "business_id" integer NOT NULL,
  "location_id" integer NOT NULL,
  "customer_id" integer,
  "staff_id" integer,
  "service_kind" varchar(20) NOT NULL,
  "title" varchar(255) NOT NULL,
  "notes" text,
  "starts_at" timestamp NOT NULL,
  "ends_at" timestamp NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "service_agreement_id" integer,
  "created_at" timestamp DEFAULT NOW(),
  CONSTRAINT "bookings_business_id_fk"
    FOREIGN KEY ("business_id")
    REFERENCES "businesses"("id"),
  CONSTRAINT "bookings_location_id_fk"
    FOREIGN KEY ("location_id")
    REFERENCES "locations"("id"),
  CONSTRAINT "bookings_customer_id_fk"
    FOREIGN KEY ("customer_id")
    REFERENCES "customers"("id"),
  CONSTRAINT "bookings_staff_id_fk"
    FOREIGN KEY ("staff_id")
    REFERENCES "staff_members"("id"),
  CONSTRAINT "bookings_service_agreement_id_fk"
    FOREIGN KEY ("service_agreement_id")
    REFERENCES "service_agreements"("id")
);

CREATE INDEX IF NOT EXISTS "bookings_business_idx"
  ON "bookings" ("business_id");

CREATE INDEX IF NOT EXISTS "bookings_location_idx"
  ON "bookings" ("location_id");

CREATE INDEX IF NOT EXISTS "bookings_starts_at_idx"
  ON "bookings" ("starts_at");

CREATE INDEX IF NOT EXISTS "bookings_staff_idx"
  ON "bookings" ("staff_id");
