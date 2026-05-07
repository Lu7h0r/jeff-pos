ALTER TABLE "service_agreements"
ADD COLUMN "default_commission_rate_bps" integer NOT NULL DEFAULT 3000;

CREATE TABLE "service_agreement_sessions" (
  "id" serial PRIMARY KEY,
  "service_agreement_id" integer NOT NULL REFERENCES "service_agreements"("id"),
  "business_id" integer NOT NULL REFERENCES "businesses"("id"),
  "location_id" integer NOT NULL REFERENCES "locations"("id"),
  "staff_member_id" integer NOT NULL REFERENCES "staff_members"("id"),
  "scheduled_for" timestamp NOT NULL,
  "session_amount" integer NOT NULL DEFAULT 0,
  "commission_rate_bps" integer NOT NULL DEFAULT 3000,
  "status" varchar(20) NOT NULL DEFAULT 'scheduled',
  "notes" text,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamp DEFAULT NOW(),
  "updated_at" timestamp DEFAULT NOW()
);

CREATE TABLE "service_agreement_commissions" (
  "id" serial PRIMARY KEY,
  "service_agreement_id" integer NOT NULL REFERENCES "service_agreements"("id"),
  "service_agreement_session_id" integer NOT NULL REFERENCES "service_agreement_sessions"("id"),
  "business_id" integer NOT NULL REFERENCES "businesses"("id"),
  "location_id" integer NOT NULL REFERENCES "locations"("id"),
  "staff_member_id" integer NOT NULL REFERENCES "staff_members"("id"),
  "commission_base_amount" integer NOT NULL,
  "commission_rate_bps" integer NOT NULL,
  "commission_amount" integer NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'estimated',
  "notes" text,
  "calculated_by_user_id" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamp DEFAULT NOW(),
  "updated_at" timestamp DEFAULT NOW()
);
