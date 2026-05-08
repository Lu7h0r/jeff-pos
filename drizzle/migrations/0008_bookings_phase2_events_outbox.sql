CREATE TABLE IF NOT EXISTS "booking_events" (
  "id" serial PRIMARY KEY,
  "booking_id" integer NOT NULL,
  "business_id" integer NOT NULL,
  "event_type" varchar(50) NOT NULL,
  "payload_json" text NOT NULL,
  "actor_user_id" text,
  "created_at" timestamp DEFAULT NOW(),
  CONSTRAINT "booking_events_booking_id_fk"
    FOREIGN KEY ("booking_id")
    REFERENCES "bookings"("id"),
  CONSTRAINT "booking_events_business_id_fk"
    FOREIGN KEY ("business_id")
    REFERENCES "businesses"("id"),
  CONSTRAINT "booking_events_actor_user_id_fk"
    FOREIGN KEY ("actor_user_id")
    REFERENCES "user"("id")
);

CREATE INDEX IF NOT EXISTS "booking_events_booking_idx"
  ON "booking_events" ("booking_id");

CREATE INDEX IF NOT EXISTS "booking_events_business_idx"
  ON "booking_events" ("business_id");

CREATE INDEX IF NOT EXISTS "booking_events_created_at_idx"
  ON "booking_events" ("created_at");

ALTER TABLE "follow_up_outbox_events"
  ADD COLUMN IF NOT EXISTS "booking_id" integer;

ALTER TABLE "follow_up_outbox_events"
  ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(191);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'follow_up_outbox_events_booking_id_fk'
  ) THEN
    ALTER TABLE "follow_up_outbox_events"
      ADD CONSTRAINT "follow_up_outbox_events_booking_id_fk"
      FOREIGN KEY ("booking_id")
      REFERENCES "bookings"("id");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "follow_up_outbox_events_idempotency_uidx"
  ON "follow_up_outbox_events" ("idempotency_key");
