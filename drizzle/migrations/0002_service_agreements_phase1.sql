CREATE TABLE IF NOT EXISTS "service_agreements" (
  "id" serial PRIMARY KEY,
  "business_id" integer NOT NULL REFERENCES "businesses"("id"),
  "location_id" integer NOT NULL REFERENCES "locations"("id"),
  "customer_id" integer REFERENCES "customers"("id"),
  "created_by_user_id" text NOT NULL REFERENCES "user"("id"),
  "service_name" varchar(255) NOT NULL,
  "total_agreed_amount" integer NOT NULL,
  "total_paid_amount" integer NOT NULL DEFAULT 0,
  "pending_amount" integer NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "notes" text,
  "created_at" timestamp DEFAULT NOW(),
  "updated_at" timestamp DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "service_agreement_payments" (
  "id" serial PRIMARY KEY,
  "service_agreement_id" integer NOT NULL REFERENCES "service_agreements"("id"),
  "order_id" integer NOT NULL REFERENCES "orders"("id"),
  "payment_method_id" integer NOT NULL REFERENCES "payment_methods"("id"),
  "cash_session_id" integer NOT NULL REFERENCES "cash_sessions"("id"),
  "amount" integer NOT NULL,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id"),
  "notes" text,
  "created_at" timestamp DEFAULT NOW()
);
