ALTER TABLE "products"
ADD COLUMN IF NOT EXISTS "image_url" text;

ALTER TABLE "products"
ADD COLUMN IF NOT EXISTS "image_urls_json" text;
