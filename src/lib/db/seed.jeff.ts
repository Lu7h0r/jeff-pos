import { db } from ".";
import {
  businesses,
  businessMembers,
  locations,
  products,
  inventoryBalances,
  inventoryMovements,
  expenseCategories,
  expenseEntries,
  suppliers,
  purchaseOrders,
  purchaseItems,
} from "./schema";
import { auth } from "../auth";
import { eq, and, inArray, gte } from "drizzle-orm";

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

  // ── Batch 6: expense categories + sample entries + supplier + purchase ────
  // Idempotent: categories matched by (business_id, name); supplier by
  // (business_id, name); expense entries by description; purchase by notes.
  const categorySeed = [
    { name: "Arriendo", kind: "recurring" as const },
    { name: "Servicios", kind: "recurring" as const },
    { name: "Insumos", kind: "operational" as const },
    { name: "Marketing", kind: "operational" as const },
  ];

  const existingCats = await db
    .select()
    .from(expenseCategories)
    .where(eq(expenseCategories.business_id, businessId));
  const existingCatByName = new Map(existingCats.map((c) => [c.name, c]));

  let seededCategories = 0;
  for (const cat of categorySeed) {
    if (existingCatByName.has(cat.name)) continue;
    const [created] = await db
      .insert(expenseCategories)
      .values({ business_id: businessId, name: cat.name, kind: cat.kind })
      .returning();
    existingCatByName.set(created.name, created);
    seededCategories += 1;
  }

  let seededSupplier = 0;
  const SUPPLIER_NAME = "Distribuidora Demo";
  const [existingSupplier] = await db
    .select()
    .from(suppliers)
    .where(
      and(
        eq(suppliers.business_id, businessId),
        eq(suppliers.name, SUPPLIER_NAME),
      ),
    )
    .limit(1);

  let supplierId: number;
  if (existingSupplier) {
    supplierId = existingSupplier.id;
  } else {
    const [created] = await db
      .insert(suppliers)
      .values({
        business_id: businessId,
        name: SUPPLIER_NAME,
        contact_email: "ventas@distri.demo",
        contact_phone: "+57 300 000 0000",
      })
      .returning();
    supplierId = created.id;
    seededSupplier = 1;
  }

  let seededExpenses = 0;
  if (amparo) {
    const expenseSeed: Array<{
      categoryName: string;
      amount: number;
      description: string;
    }> = [
      {
        categoryName: "Arriendo",
        amount: 1_430_000_00,
        description: "Arriendo Amparo (mes corriente)",
      },
      {
        categoryName: "Servicios",
        amount: 230_000_00,
        description: "Luz Amparo (mes corriente)",
      },
    ];

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    for (const exp of expenseSeed) {
      const cat = existingCatByName.get(exp.categoryName);
      if (!cat) continue;
      const existing = await db
        .select()
        .from(expenseEntries)
        .where(
          and(
            eq(expenseEntries.business_id, businessId),
            eq(expenseEntries.description, exp.description),
            gte(expenseEntries.incurred_at, monthStart),
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;

      await db.insert(expenseEntries).values({
        business_id: businessId,
        location_id: amparo.id,
        category_id: cat.id,
        amount: exp.amount,
        incurred_at: now,
        description: exp.description,
        created_by_user_id: ownerUserId,
      });
      seededExpenses += 1;
    }
  }

  let seededPurchase = 0;
  const PURCHASE_NOTE = "Sample purchase Britalia (Batch 6 seed)";
  if (britalia) {
    const [existingPurchase] = await db
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.business_id, businessId),
          eq(purchaseOrders.notes, PURCHASE_NOTE),
        ),
      )
      .limit(1);

    if (!existingPurchase) {
      const britaliaProducts = await db
        .select()
        .from(products)
        .where(
          and(
            eq(products.business_id, businessId),
            inArray(products.sku, ["INK-BLACK-30", "NEEDLE-3RL"]),
          ),
        );
      const ink = britaliaProducts.find((p) => p.sku === "INK-BLACK-30");
      const needle = britaliaProducts.find((p) => p.sku === "NEEDLE-3RL");

      if (ink && needle) {
        const items = [
          { product: ink, quantity: 5, unit_cost: 18_000 },
          { product: needle, quantity: 10, unit_cost: 22_000 },
        ];
        const total = items.reduce(
          (sum, it) => sum + it.quantity * it.unit_cost,
          0,
        );

        const [order] = await db
          .insert(purchaseOrders)
          .values({
            business_id: businessId,
            location_id: britalia.id,
            supplier_id: supplierId,
            status: "received",
            total_amount: total,
            notes: PURCHASE_NOTE,
            created_by_user_id: ownerUserId,
            received_at: new Date(),
          })
          .returning();

        for (const it of items) {
          await db.insert(purchaseItems).values({
            purchase_order_id: order.id,
            product_id: it.product.id,
            quantity: it.quantity,
            unit_cost: it.unit_cost,
            total_cost: it.quantity * it.unit_cost,
          });

          const [bal] = await db
            .select()
            .from(inventoryBalances)
            .where(
              and(
                eq(inventoryBalances.location_id, britalia.id),
                eq(inventoryBalances.product_id, it.product.id),
              ),
            )
            .limit(1);
          if (bal) {
            await db
              .update(inventoryBalances)
              .set({
                quantity_on_hand: bal.quantity_on_hand + it.quantity,
                updated_at: new Date(),
              })
              .where(eq(inventoryBalances.id, bal.id));
          } else {
            await db.insert(inventoryBalances).values({
              business_id: businessId,
              location_id: britalia.id,
              product_id: it.product.id,
              quantity_on_hand: it.quantity,
              quantity_reserved: 0,
            });
          }

          await db.insert(inventoryMovements).values({
            business_id: businessId,
            location_id: britalia.id,
            product_id: it.product.id,
            quantity_delta: it.quantity,
            type: "purchase",
            source_type: "purchase_order",
            source_id: order.id,
            created_by_user_id: ownerUserId,
            notes: PURCHASE_NOTE,
          });
        }
        seededPurchase = 1;
      }
    }
  }

  console.log(
    `Seeded Jeff: business=${BUSINESS_SLUG} (id=${businessId}), ` +
      `owner=${JEFF_OWNER_EMAIL} (password=${JEFF_OWNER_PASSWORD}), ` +
      `locations=Amparo+Britalia, ` +
      `products=+${seededProducts} (total ${sampleProducts.length}), ` +
      `balances=+${seededBalances}, ` +
      `expense_categories=+${seededCategories}, ` +
      `expense_entries=+${seededExpenses}, ` +
      `suppliers=+${seededSupplier}, ` +
      `purchases=+${seededPurchase}`,
  );
}

if (import.meta.main) {
  await seedJeff();
  process.exit(0);
}
