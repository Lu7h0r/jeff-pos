import { db } from "../src/lib/db";
import { businesses, businessMembers, locations } from "../src/lib/db/schema";
import { auth } from "../src/lib/auth";
import { eq } from "drizzle-orm";

// Idempotent production bootstrap. Creates the owner user, the business and
// the configured locations. Safe to re-run: existing rows are reused.
//
// Configuration via env vars:
//   BOOTSTRAP_OWNER_EMAIL       (required)
//   BOOTSTRAP_OWNER_PASSWORD    (required, min 8)
//   BOOTSTRAP_OWNER_NAME        (required)
//   BOOTSTRAP_BUSINESS_NAME     (required)
//   BOOTSTRAP_BUSINESS_SLUG     (required, lowercase a-z0-9-)
//   BOOTSTRAP_LOCATIONS         (required, format "slug:Name,slug:Name")
//
// Run with: bun scripts/bootstrap-prod.ts
//
// IMPORTANT: This is for first-time provisioning only. Do NOT wire this into
// the build/start lifecycle. Demo seeding lives in src/lib/db/seed.jeff.ts and
// only runs in dev.

interface LocationSpec {
  slug: string;
  name: string;
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function parseLocations(raw: string): LocationSpec[] {
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [slug, name] = entry.split(":").map((s) => s?.trim());
      if (!slug || !name) {
        throw new Error(
          `Invalid BOOTSTRAP_LOCATIONS entry "${entry}". Expected "slug:Name".`,
        );
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        throw new Error(`Invalid location slug "${slug}". Use a-z, 0-9, dash.`);
      }
      return { slug, name };
    });

  if (parsed.length === 0) {
    throw new Error("BOOTSTRAP_LOCATIONS produced zero locations.");
  }
  return parsed;
}

async function main() {
  const ownerEmail = readEnv("BOOTSTRAP_OWNER_EMAIL");
  const ownerPassword = readEnv("BOOTSTRAP_OWNER_PASSWORD");
  const ownerName = readEnv("BOOTSTRAP_OWNER_NAME");
  const businessName = readEnv("BOOTSTRAP_BUSINESS_NAME");
  const businessSlug = readEnv("BOOTSTRAP_BUSINESS_SLUG");
  const locationSpecs = parseLocations(readEnv("BOOTSTRAP_LOCATIONS"));

  if (!/^[a-z0-9][a-z0-9-]*$/.test(businessSlug)) {
    throw new Error(`Invalid BOOTSTRAP_BUSINESS_SLUG "${businessSlug}".`);
  }
  if (ownerPassword.length < 8) {
    throw new Error("BOOTSTRAP_OWNER_PASSWORD must be at least 8 characters.");
  }

  let ownerUserId: string;
  try {
    const signUpRes = await auth.api.signUpEmail({
      body: { name: ownerName, email: ownerEmail, password: ownerPassword },
    });
    ownerUserId = signUpRes.user.id;
    console.log(`✓ Owner created: ${ownerEmail}`);
  } catch {
    const signInRes = await auth.api.signInEmail({
      body: { email: ownerEmail, password: ownerPassword },
    });
    ownerUserId = signInRes.user.id;
    console.log(`✓ Owner already exists: ${ownerEmail}`);
  }

  const [existingBusiness] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.slug, businessSlug))
    .limit(1);

  let businessId: number;
  if (existingBusiness) {
    businessId = existingBusiness.id;
    console.log(`✓ Business already exists: ${businessSlug} (id=${businessId})`);
  } else {
    const [created] = await db
      .insert(businesses)
      .values({ name: businessName, slug: businessSlug })
      .returning();
    businessId = created.id;
    console.log(`✓ Business created: ${businessSlug} (id=${businessId})`);
  }

  const [existingMembership] = await db
    .select()
    .from(businessMembers)
    .where(eq(businessMembers.user_id, ownerUserId))
    .limit(1);

  if (!existingMembership) {
    await db.insert(businessMembers).values({
      business_id: businessId,
      user_id: ownerUserId,
      role: "owner",
      status: "active",
    });
    console.log(`✓ Owner membership attached`);
  } else {
    console.log(`✓ Owner membership already attached`);
  }

  const existingLocations = await db
    .select()
    .from(locations)
    .where(eq(locations.business_id, businessId));
  const existingSlugs = new Set(existingLocations.map((loc) => loc.slug));

  for (const spec of locationSpecs) {
    if (existingSlugs.has(spec.slug)) {
      console.log(`✓ Location already exists: ${spec.slug}`);
      continue;
    }
    await db.insert(locations).values({
      business_id: businessId,
      slug: spec.slug,
      name: spec.name,
    });
    console.log(`✓ Location created: ${spec.slug} (${spec.name})`);
  }

  console.log("\nBootstrap complete.");
  console.log(`  Login: ${ownerEmail}`);
  console.log(`  Business: ${businessName} (${businessSlug})`);
  console.log(`  Locations: ${locationSpecs.map((l) => l.slug).join(", ")}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Bootstrap failed:", err);
    process.exit(1);
  });
