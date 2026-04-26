import { db } from ".";
import {
  paymentMethods,
  customers,
  products,
  orders,
  orderItems,
  orderPayments,
  businesses,
  businessMembers,
  locations,
  cashSessions,
} from "./schema";
import { sql } from "drizzle-orm";
import { faker } from "@faker-js/faker";
import { auth } from "../auth";

const DEMO_EMAIL = "test@example.com";
const DEMO_PASSWORD = "test1234";
const DEMO_NAME = "Test User";
const DEMO_BUSINESS_SLUG = "demo";
const DEMO_LOCATION_SLUG = "main";

export async function seed() {
  const existing = await db
    .select({ count: sql<number>`count(*)` })
    .from(paymentMethods);

  if (existing[0].count > 0) return;

  // ── Payment Methods ──────────────────────────────────────────────────────
  const [pmCredit, pmDebit, pmCash] = await db
    .insert(paymentMethods)
    .values([
      { name: "Credit Card" },
      { name: "Debit Card" },
      { name: "Cash" },
    ])
    .returning();

  const paymentMethodIds = [pmCredit.id, pmDebit.id, pmCash.id];

  // ── Demo User ────────────────────────────────────────────────────────────
  const signUpRes = await auth.api.signUpEmail({
    body: { name: DEMO_NAME, email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  const userId = signUpRes.user.id;

  // ── Demo Business + Membership + Location + Open Cash Session (DA-7) ─────
  // Batch 4 made products.business_id and orders.business_id NOT NULL. The
  // demo seed needs a real business so it remains end-to-end runnable.
  const [demoBusiness] = await db
    .insert(businesses)
    .values({ name: "Demo Business", slug: DEMO_BUSINESS_SLUG })
    .returning();
  const demoBusinessId = demoBusiness.id;

  await db.insert(businessMembers).values({
    business_id: demoBusinessId,
    user_id: userId,
    role: "owner",
    status: "active",
  });

  const [demoLocation] = await db
    .insert(locations)
    .values({
      business_id: demoBusinessId,
      name: "Demo Location",
      slug: DEMO_LOCATION_SLUG,
    })
    .returning();
  const demoLocationId = demoLocation.id;

  // Single open cash session covers all demo orders. Left open intentionally
  // so the demo runs against a live session out of the box.
  const [demoSession] = await db
    .insert(cashSessions)
    .values({
      business_id: demoBusinessId,
      location_id: demoLocationId,
      opened_by_user_id: userId,
      opening_cash_amount: 100_000,
      expected_cash_amount: 100_000,
      expected_digital_amount: 0,
      status: "open",
    })
    .returning();
  const demoSessionId = demoSession.id;

  // ── Customers ────────────────────────────────────────────────────────────
  const customerValues = Array.from({ length: 20 }, () => ({
    name: faker.person.fullName(),
    email: faker.internet.email().toLowerCase(),
    phone: faker.phone.number({ style: "national" }),
    user_uid: userId,
    business_id: demoBusinessId,
    status: faker.helpers.arrayElement(["active", "active", "active", "inactive"]),
    created_at: faker.date.recent({ days: 90 }),
  }));

  const insertedCustomers = await db
    .insert(customers)
    .values(customerValues)
    .returning();

  // ── Products ─────────────────────────────────────────────────────────────
  const productNames: Record<string, string[]> = {
    electronics: [
      "Wireless Mouse", "Mechanical Keyboard", "USB-C Hub", "Webcam HD",
      "Bluetooth Speaker", "LED Monitor 24\"", "Phone Charger", "HDMI Cable",
    ],
    clothing: [
      "Cotton T-Shirt", "Denim Jacket", "Running Shoes", "Baseball Cap",
      "Wool Scarf", "Leather Belt", "Polo Shirt", "Cargo Pants",
    ],
    books: [
      "Clean Code", "Design Patterns", "The Pragmatic Programmer",
      "Refactoring", "Domain-Driven Design", "System Design Interview",
      "JavaScript: The Good Parts", "Learning SQL",
    ],
    home: [
      "Ceramic Mug", "Desk Lamp", "Wall Clock", "Throw Pillow",
      "Kitchen Scale", "Glass Vase", "Bath Towel Set", "Scented Candle",
    ],
  };

  const productValues = Object.entries(productNames).flatMap(
    ([category, names]) =>
      names.map((name) => ({
        name,
        description: faker.commerce.productDescription(),
        price: faker.number.int({ min: 499, max: 29999 }),
        in_stock: faker.number.int({ min: 0, max: 200 }),
        user_uid: userId,
        category,
        business_id: demoBusinessId,
        status: "active",
      }))
  );

  const insertedProducts = await db
    .insert(products)
    .values(productValues)
    .returning();

  // ── Orders + Order Items + Order Payments ────────────────────────────────
  const orderCount = 40;
  for (let i = 0; i < orderCount; i++) {
    const customer = faker.helpers.arrayElement(insertedCustomers);
    const pmId = faker.helpers.arrayElement(paymentMethodIds);
    const itemCount = faker.number.int({ min: 1, max: 5 });
    const chosenProducts = faker.helpers.arrayElements(
      insertedProducts,
      itemCount
    );

    const items = chosenProducts.map((p) => ({
      product_id: p.id,
      quantity: faker.number.int({ min: 1, max: 4 }),
      price: p.price,
    }));

    const totalAmount = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const createdAt = faker.date.recent({ days: 60 });

    const lifecycle = faker.helpers.weightedArrayElement([
      { value: "complete", weight: 8 },
      { value: "pending", weight: 1.5 },
      { value: "void", weight: 0.5 },
    ]);

    const [order] = await db
      .insert(orders)
      .values({
        customer_id: customer.id,
        total_amount: totalAmount,
        user_uid: userId,
        business_id: demoBusinessId,
        location_id: demoLocationId,
        cash_session_id: demoSessionId,
        payment_status: lifecycle === "complete" ? "paid" : "unpaid",
        process_status: lifecycle,
        created_at: createdAt,
      })
      .returning();

    const productNameById = new Map(
      insertedProducts.map((p) => [p.id, p.name] as const),
    );

    await db.insert(orderItems).values(
      items.map((item) => ({
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        price: item.price,
        product_name: productNameById.get(item.product_id) ?? null,
        unit_price: item.price,
        unit_cost: null,
        total_price: item.price * item.quantity,
      })),
    );

    if (lifecycle === "complete") {
      await db.insert(orderPayments).values({
        order_id: order.id,
        payment_method_id: pmId,
        cash_session_id: demoSessionId,
        amount: totalAmount,
        created_by_user_id: userId,
        created_at: createdAt,
      });
    }
  }

  console.log(
    `Seeded: 3 payment methods, 1 demo user (${DEMO_EMAIL} / ${DEMO_PASSWORD}), ` +
      `${customerValues.length} customers, ${productValues.length} products, ` +
      `${orderCount} orders`
  );
}
