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
  staffMembers,
  workstations,
  stationRentals,
  locationMembers,
} from "./schema";
import { auth } from "../auth";
import { eq, and, inArray, gte } from "drizzle-orm";

const JEFF_OWNER_EMAIL = "jeff@jeff.studio";
const JEFF_OWNER_PASSWORD = "jeff1234";
const JEFF_OWNER_NAME = "Jeff Owner";
const BUSINESS_SLUG = "jeff";

// Sample granular cashier user — exercises the location_members path in
// resolveActiveContext for end-to-end testing of the auth-management batch.
const SAMPLE_CASHIER_EMAIL = "cashier@jeff.studio";
const SAMPLE_CASHIER_PASSWORD = "cashier1234";
const SAMPLE_CASHIER_NAME = "Sample Cashier";

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

  // Service products are intangible — no inventory balance and no SKU. They
  // are matched idempotently by name within the business. Prices are stored
  // as cents (matches the rest of the catalogue) so 200_000_00 = COP 200.000.
  const sampleServices: Array<{
    name: string;
    price: number;
    defaultServiceKind:
      | "tattoo"
      | "piercing"
      | "touchup"
      | "removal"
      | "consultation"
      | "other";
  }> = [
    { name: "Sesion tatuaje pequeño (1h)", price: 200_000_00, defaultServiceKind: "tattoo" },
    { name: "Sesion tatuaje mediano (3h)", price: 500_000_00, defaultServiceKind: "tattoo" },
    { name: "Piercing oreja (estandar)", price: 80_000_00, defaultServiceKind: "piercing" },
    { name: "Touchup tatuaje", price: 100_000_00, defaultServiceKind: "touchup" },
    { name: "Consulta diseño tatuaje", price: 0, defaultServiceKind: "consultation" },
  ];

  let seededProducts = 0;
  let seededBalances = 0;
  let seededServices = 0;

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
            kind: "product",
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

  // ── Service products (Capa 8) ─────────────────────────────────────────────
  // Idempotent by (business_id, name). Services are intangible: no inventory
  // balance, no SKU, no cost. They surface in the POS catalogue grouped under
  // "Servicios" and prefill the attach dialog with `default_service_kind`.
  const serviceNames = sampleServices.map((s) => s.name);
  const existingServices = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.business_id, businessId),
        inArray(products.name, serviceNames),
      ),
    );
  const existingServiceByName = new Map(
    existingServices.map((p) => [p.name, p]),
  );

  for (const svc of sampleServices) {
    if (existingServiceByName.has(svc.name)) continue;
    await db.insert(products).values({
      name: svc.name,
      price: svc.price,
      in_stock: 0,
      user_uid: ownerUserId,
      business_id: businessId,
      status: "active",
      kind: "service",
      default_service_kind: svc.defaultServiceKind,
    });
    seededServices += 1;
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

  // ── Batch 8: staff, workstations, sample station rental ──────────────────
  // Idempotent: staff matched by (business_id, display_name); workstations
  // matched by (business_id, location_id, name); rental matched by notes.
  const staffSeed: Array<{
    displayName: string;
    kind: "manager" | "artist";
    commissionRate: number;
    defaultSplit:
      | "owner_direct"
      | "staff_30_house_70"
      | "staff_50_house_50"
      | "staff_70_house_30"
      | "manual";
  }> = [
    { displayName: "Jeff Owner", kind: "manager", commissionRate: 0, defaultSplit: "owner_direct" },
    { displayName: "Sample Artist", kind: "artist", commissionRate: 3000, defaultSplit: "staff_30_house_70" },
  ];

  const existingStaff = await db
    .select()
    .from(staffMembers)
    .where(eq(staffMembers.business_id, businessId));
  const existingStaffByName = new Map(
    existingStaff.map((s) => [s.display_name, s]),
  );

  let seededStaff = 0;
  let sampleArtistId: number | null =
    existingStaffByName.get("Sample Artist")?.id ?? null;

  for (const s of staffSeed) {
    if (existingStaffByName.has(s.displayName)) continue;
    const [created] = await db
      .insert(staffMembers)
      .values({
        business_id: businessId,
        display_name: s.displayName,
        kind: s.kind,
        commission_rate: s.commissionRate,
        default_split: s.defaultSplit,
      })
      .returning();
    if (created.display_name === "Sample Artist") sampleArtistId = created.id;
    seededStaff += 1;
  }

  let seededWorkstations = 0;
  let cabina1Id: number | null = null;
  if (amparo) {
    const [existingCabina1] = await db
      .select()
      .from(workstations)
      .where(
        and(
          eq(workstations.business_id, businessId),
          eq(workstations.location_id, amparo.id),
          eq(workstations.name, "Cabina 1"),
        ),
      )
      .limit(1);
    if (existingCabina1) {
      cabina1Id = existingCabina1.id;
    } else {
      const [created] = await db
        .insert(workstations)
        .values({
          business_id: businessId,
          location_id: amparo.id,
          name: "Cabina 1",
          kind: "tattoo",
        })
        .returning();
      cabina1Id = created.id;
      seededWorkstations += 1;
    }
  }

  if (britalia) {
    const [existingBox] = await db
      .select()
      .from(workstations)
      .where(
        and(
          eq(workstations.business_id, businessId),
          eq(workstations.location_id, britalia.id),
          eq(workstations.name, "Box Piercer"),
        ),
      )
      .limit(1);
    if (!existingBox) {
      await db.insert(workstations).values({
        business_id: businessId,
        location_id: britalia.id,
        name: "Box Piercer",
        kind: "piercing",
      });
      seededWorkstations += 1;
    }
  }

  let seededRental = 0;
  const RENTAL_NOTE = "Sample station rental (Batch 8 seed)";
  if (amparo && cabina1Id && sampleArtistId) {
    const [existingRental] = await db
      .select()
      .from(stationRentals)
      .where(
        and(
          eq(stationRentals.business_id, businessId),
          eq(stationRentals.notes, RENTAL_NOTE),
        ),
      )
      .limit(1);
    if (!existingRental) {
      const today = new Date();
      const startAt = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        14,
        0,
        0,
      );
      const endAt = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        18,
        0,
        0,
      );
      await db.insert(stationRentals).values({
        business_id: businessId,
        location_id: amparo.id,
        workstation_id: cabina1Id,
        staff_member_id: sampleArtistId,
        amount: 50_000_00,
        start_at: startAt,
        end_at: endAt,
        status: "scheduled",
        notes: RENTAL_NOTE,
        created_by_user_id: ownerUserId,
      });
      seededRental = 1;
    }
  }

  // ── Auth Management: sample location-scoped cashier ─────────────────────
  // Idempotent: signs up Better Auth user if missing, then attaches a single
  // location_members row for Amparo with role=cashier (granular scope).
  let seededCashier = 0;
  if (amparo) {
    let cashierUserId: string | null = null;
    try {
      const signUpRes = await auth.api.signUpEmail({
        body: {
          name: SAMPLE_CASHIER_NAME,
          email: SAMPLE_CASHIER_EMAIL,
          password: SAMPLE_CASHIER_PASSWORD,
        },
      });
      cashierUserId = signUpRes.user.id;
      seededCashier = 1;
    } catch {
      const signInRes = await auth.api.signInEmail({
        body: {
          email: SAMPLE_CASHIER_EMAIL,
          password: SAMPLE_CASHIER_PASSWORD,
        },
      });
      cashierUserId = signInRes.user.id;
    }

    if (cashierUserId) {
      const existingMembership = await db
        .select()
        .from(locationMembers)
        .where(eq(locationMembers.user_id, cashierUserId))
        .limit(1);

      if (existingMembership.length === 0) {
        await db.insert(locationMembers).values({
          business_id: businessId,
          location_id: amparo.id,
          user_id: cashierUserId,
          role: "cashier",
          status: "active",
        });
      }
    }
  }

  console.log(
    `Seeded Jeff: business=${BUSINESS_SLUG} (id=${businessId}), ` +
      `owner=${JEFF_OWNER_EMAIL} (password=${JEFF_OWNER_PASSWORD}), ` +
      `locations=Amparo+Britalia, ` +
      `products=+${seededProducts} (total ${sampleProducts.length}), ` +
      `services=+${seededServices} (total ${sampleServices.length}), ` +
      `balances=+${seededBalances}, ` +
      `expense_categories=+${seededCategories}, ` +
      `expense_entries=+${seededExpenses}, ` +
      `suppliers=+${seededSupplier}, ` +
      `purchases=+${seededPurchase}, ` +
      `staff=+${seededStaff}, ` +
      `workstations=+${seededWorkstations}, ` +
      `station_rentals=+${seededRental}, ` +
      `cashier=${seededCashier} (email=${SAMPLE_CASHIER_EMAIL}, password=${SAMPLE_CASHIER_PASSWORD}, scope=Amparo)`,
  );
}

if (import.meta.main) {
  await seedJeff();
  process.exit(0);
}
