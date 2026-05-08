ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "confirmation_status" varchar(20) NOT NULL DEFAULT 'pending';
