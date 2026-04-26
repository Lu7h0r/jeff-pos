import { db } from ".";
import {
  businesses,
  businessMembers,
  locations,
  products,
  inventoryBalances,
  inventoryMovements,
} from "./schema";
import { auth } from "../auth";
import { eq, and, inArray } from "drizzle-orm";

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

  // ── Sample products + initial inventory (Batch 3) ─────────────────────────
  // Idempotent by sku within the Jeff business. For each product we seed a
  // balance row at Amparo and Britalia plus an `initial_import` movement
  // matching the seeded quantity_on_hand.
  const allLocations = await db
    .select()
    .from(locations)
    .where(eq(locations.business_id, businessId));
  const amparo = allLocations.find((loc) => loc.slug === "amparo");
  const britalia = allLocations.find((loc) => loc.slug === "britalia");

  const sampleProducts: Array<{
    sku: string;
    name: string;
    price: number;
    cost: number;
    amparoQty: number;
    britaliaQty: number;
  }> = [
    { sku: "INK-BLACK-30", name: "Tinta Negra 30ml", price: 35_000, cost: 18_000, amparoQty: 25, britaliaQty: 12 },
    { sku: "INK-RED-30", name: "Tinta Roja 30ml", price: 38_000, cost: 19_000, amparoQty: 18, britaliaQty: 10 },
    { sku: "NEEDLE-3RL", name: "Aguja 3RL caja x20", price: 45_000, cost: 22_000, amparoQty: 30, britaliaQty: 15 },
    { sku: "GLOVE-M", name: "Guantes nitrilo M caja x100", price: 28_000, cost: 14_000, amparoQty: 22, britaliaQty: 18 },
    { sku: "GRIP-25MM", name: "Grip desechable 25mm", price: 12_000, cost: 5_500, amparoQty: 15, britaliaQty: 8 },
  ];

  let seededProducts = 0;
  let seededBalances = 0;

  if (amparo && britalia) {
    const skus = sampleProducts.map((p) => p.sku);
    const existing = await db
      .select()
      .from(products)
      .where(and(eq(products.business_id, businessId), inArray(products.sku, skus)));
    const existingBySku = new Map(existing.map((p) => [p.sku, p]));

    for (const sample of sampleProducts) {
      let productId: number;
      const existingProduct = existingBySku.get(sample.sku);
      if (existingProduct) {
        productId = existingProduct.id;
      } else {
        const [created] = await db
          .insert(products)
          .values({
            name: sample.name,
            price: sample.price,
            in_stock: sample.amparoQty + sample.britaliaQty,
            user_uid: ownerUserId,
            business_id: businessId,
            sku: sample.sku,
            cost_amount: sample.cost,
            status: "active",
          })
          .returning();
        productId = created.id;
        seededProducts += 1;
      }

      for (const [loc, qty] of [
        [amparo, sample.amparoQty] as const,
        [britalia, sample.britaliaQty] as const,
      ]) {
        const [existingBalance] = await db
          .select()
          .from(inventoryBalances)
          .where(
            and(
              eq(inventoryBalances.location_id, loc.id),
              eq(inventoryBalances.product_id, productId),
            ),
          )
          .limit(1);

        if (existingBalance) continue;

        await db.insert(inventoryBalances).values({
          business_id: businessId,
          location_id: loc.id,
          product_id: productId,
          quantity_on_hand: qty,
          quantity_reserved: 0,
        });

        await db.insert(inventoryMovements).values({
          business_id: businessId,
          location_id: loc.id,
          product_id: productId,
          quantity_delta: qty,
          type: "initial_import",
          source_type: "seed",
          source_id: null,
          created_by_user_id: ownerUserId,
          notes: "Seeded by seed.jeff.ts",
        });

        seededBalances += 1;
      }
    }
  }

  console.log(
    `Seeded Jeff: business=${BUSINESS_SLUG} (id=${businessId}), ` +
      `owner=${JEFF_OWNER_EMAIL} (password=${JEFF_OWNER_PASSWORD}), ` +
      `locations=Amparo+Britalia, ` +
      `products=+${seededProducts} (total ${sampleProducts.length}), ` +
      `balances=+${seededBalances}`,
  );
}

if (import.meta.main) {
  await seedJeff();
  process.exit(0);
}
