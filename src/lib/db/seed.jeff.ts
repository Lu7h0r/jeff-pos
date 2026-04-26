import { db } from ".";
import {
  businesses,
  businessMembers,
  locations,
} from "./schema";
import { auth } from "../auth";
import { eq } from "drizzle-orm";

const JEFF_OWNER_EMAIL = "jeff@jeff.studio";
const JEFF_OWNER_PASSWORD = "jeff1234";
const JEFF_OWNER_NAME = "Jeff Owner";
const BUSINESS_SLUG = "jeff";

/**
 * Idempotent seed for the Jeff business. Safe to run multiple times.
 *
 * Creates (or reuses):
 *   - Better Auth user jeff@jeff.studio / jeff1234
 *   - business "Jeff Studio" (slug: jeff)
 *   - locations Amparo and Britalia
 *   - owner membership linking the user to the business
 *
 * Independent from the demo seed.ts. Run with:
 *   bun run db:push && bun src/lib/db/seed.jeff.ts
 */
export async function seedJeff(): Promise<void> {
  // Resolve or create the owner user via Better Auth
  let ownerUserId: string;
  try {
    const signUpRes = await auth.api.signUpEmail({
      body: {
        name: JEFF_OWNER_NAME,
        email: JEFF_OWNER_EMAIL,
        password: JEFF_OWNER_PASSWORD,
      },
    });
    ownerUserId = signUpRes.user.id;
  } catch {
    // Already exists — sign in to recover the id
    const signInRes = await auth.api.signInEmail({
      body: {
        email: JEFF_OWNER_EMAIL,
        password: JEFF_OWNER_PASSWORD,
      },
    });
    ownerUserId = signInRes.user.id;
  }

  // Resolve or create the business
  const existingBusiness = await db
    .select()
    .from(businesses)
    .where(eq(businesses.slug, BUSINESS_SLUG))
    .limit(1);

  let businessId: number;
  if (existingBusiness.length > 0) {
    businessId = existingBusiness[0].id;
  } else {
    const [created] = await db
      .insert(businesses)
      .values({ name: "Jeff Studio", slug: BUSINESS_SLUG })
      .returning();
    businessId = created.id;
  }

  // Resolve or create the owner membership
  const existingMembership = await db
    .select()
    .from(businessMembers)
    .where(eq(businessMembers.user_id, ownerUserId))
    .limit(1);

  if (existingMembership.length === 0) {
    await db.insert(businessMembers).values({
      business_id: businessId,
      user_id: ownerUserId,
      role: "owner",
      status: "active",
    });
  }

  // Resolve or create the two locations (idempotent by slug within business)
  const existingLocations = await db
    .select()
    .from(locations)
    .where(eq(locations.business_id, businessId));

  const existingSlugs = new Set(existingLocations.map((loc) => loc.slug));
  const toInsert = [
    { slug: "amparo", name: "Amparo" },
    { slug: "britalia", name: "Britalia" },
  ].filter((loc) => !existingSlugs.has(loc.slug));

  if (toInsert.length > 0) {
    await db
      .insert(locations)
      .values(
        toInsert.map((loc) => ({
          business_id: businessId,
          name: loc.name,
          slug: loc.slug,
        })),
      );
  }

  console.log(
    `Seeded Jeff: business=${BUSINESS_SLUG} (id=${businessId}), ` +
      `owner=${JEFF_OWNER_EMAIL} (password=${JEFF_OWNER_PASSWORD}), ` +
      `locations=Amparo+Britalia`,
  );
}

if (import.meta.main) {
  await seedJeff();
  process.exit(0);
}
