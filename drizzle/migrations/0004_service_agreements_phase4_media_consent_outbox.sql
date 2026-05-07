CREATE TABLE "service_agreement_media" (
  "id" serial PRIMARY KEY,
  "service_agreement_id" integer REFERENCES "service_agreements"("id"),
  "service_agreement_session_id" integer REFERENCES "service_agreement_sessions"("id"),
  "business_id" integer NOT NULL REFERENCES "businesses"("id"),
  "location_id" integer NOT NULL REFERENCES "locations"("id"),
  "media_url" text NOT NULL,
  "media_kind" varchar(20) NOT NULL DEFAULT 'reference',
  "mime_type" varchar(100),
  "size_bytes" integer,
  "caption" text,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamp DEFAULT NOW()
);

CREATE TABLE "customer_message_consents" (
  "id" serial PRIMARY KEY,
  "customer_id" integer NOT NULL REFERENCES "customers"("id"),
  "business_id" integer NOT NULL REFERENCES "businesses"("id"),
  "location_id" integer REFERENCES "locations"("id"),
  "channel" varchar(20) NOT NULL DEFAULT 'whatsapp',
  "status" varchar(20) NOT NULL DEFAULT 'granted',
  "source" varchar(50),
  "notes" text,
  "granted_at" timestamp,
  "revoked_at" timestamp,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamp DEFAULT NOW(),
  "updated_at" timestamp DEFAULT NOW()
);

CREATE TABLE "follow_up_outbox_events" (
  "id" serial PRIMARY KEY,
  "business_id" integer NOT NULL REFERENCES "businesses"("id"),
  "location_id" integer REFERENCES "locations"("id"),
  "customer_id" integer REFERENCES "customers"("id"),
  "service_agreement_id" integer REFERENCES "service_agreements"("id"),
  "service_agreement_session_id" integer REFERENCES "service_agreement_sessions"("id"),
  "event_type" varchar(50) NOT NULL,
  "payload_json" text NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp,
  "dispatched_at" timestamp,
  "last_error" text,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamp DEFAULT NOW(),
  "updated_at" timestamp DEFAULT NOW()
);
