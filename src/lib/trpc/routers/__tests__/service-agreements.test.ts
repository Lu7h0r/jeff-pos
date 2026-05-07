import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { serviceAgreementsRouter } = await import("../service-agreements");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(serviceAgreementsRouter);
const callerAs = (uid: string, businessId?: number) =>
  factory(makeContext(uid, { businessId: businessId ?? null }));

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let customerId: number;
let pmCashId: number;
let pmTransferId: number;
let pmOtherBizId: number;
let openSessionId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-sa@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-sa@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-sa" },
      { name: "Other Studio", slug: "other-sa" },
    ])
    .returning();
  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;

  await db.insert(schema.businessMembers).values([
    { business_id: bizJeffId, user_id: "u-jeff", role: "owner", status: "active" },
    { business_id: bizOtherId, user_id: "u-other", role: "owner", status: "active" },
  ]);

  const [location] = await db
    .insert(schema.locations)
    .values({ business_id: bizJeffId, name: "Amparo", slug: "amparo" })
    .returning();
  amparoId = location.id;

  const [customer] = await db
    .insert(schema.customers)
    .values({
      name: "Cliente Tatuaje",
      email: "cliente-tatuaje@test.com",
      user_uid: "u-jeff",
      business_id: bizJeffId,
    })
    .returning();
  customerId = customer.id;

  const [pmCash, pmTransfer, pmOtherBiz] = await db
    .insert(schema.paymentMethods)
    .values([
      { name: "Cash" },
      { name: "Transfer" },
      { name: "OtherBizCard", business_id: bizOtherId },
    ])
    .returning();
  pmCashId = pmCash.id;
  pmTransferId = pmTransfer.id;
  pmOtherBizId = pmOtherBiz.id;

  const [session] = await db
    .insert(schema.cashSessions)
    .values({
      business_id: bizJeffId,
      location_id: amparoId,
      opened_by_user_id: "u-jeff",
      opening_cash_amount: 100_000,
      expected_cash_amount: 100_000,
      expected_digital_amount: 0,
      status: "open",
    })
    .returning();
  openSessionId = session.id;
});

afterAll(async () => {
  await pg.close();
});

const jeffCaller = () => callerAs("u-jeff", bizJeffId);

describe("serviceAgreements — fase 1", () => {
  it("creates an agreement with agreed/paid/pending totals", async () => {
    const agreement = await jeffCaller().create({
      locationId: amparoId,
      customerId,
      serviceName: "Tattoo brazo completo",
      totalAgreedAmount: 500_000,
      notes: "Reserva inicial",
    });

    expect(agreement.total_agreed_amount).toBe(500_000);
    expect(agreement.total_paid_amount).toBe(0);
    expect(agreement.pending_amount).toBe(500_000);
    expect(agreement.status).toBe("active");
  });

  it("registers partial payment, updates cash session and pending totals", async () => {
    const agreement = await jeffCaller().create({
      locationId: amparoId,
      customerId,
      serviceName: "Piercing oreja",
      totalAgreedAmount: 200_000,
    });

    const updated = await jeffCaller().addPayment({
      agreementId: agreement.id,
      paymentLines: [
        { paymentMethodId: pmCashId, amount: 50_000 },
        { paymentMethodId: pmTransferId, amount: 30_000 },
      ],
      notes: "Abono inicial",
    });

    expect(updated.total_paid_amount).toBe(80_000);
    expect(updated.pending_amount).toBe(120_000);
    expect(updated.status).toBe("active");
    expect(updated.payments.length).toBe(2);

    const [sessionAfter] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    expect(sessionAfter.expected_cash_amount).toBe(150_000);
    expect(sessionAfter.expected_digital_amount).toBe(30_000);

    const [linkedOrder] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, updated.payments[0].order_id));
    expect(linkedOrder.total_amount).toBe(80_000);
  });

  it("marks agreement completed when pending becomes zero", async () => {
    const agreement = await jeffCaller().create({
      locationId: amparoId,
      serviceName: "Tattoo mini",
      totalAgreedAmount: 90_000,
    });

    const completed = await jeffCaller().addPayment({
      agreementId: agreement.id,
      paymentLines: [{ paymentMethodId: pmCashId, amount: 90_000 }],
    });

    expect(completed.total_paid_amount).toBe(90_000);
    expect(completed.pending_amount).toBe(0);
    expect(completed.status).toBe("completed");
  });

  it("rejects payment lines from another business payment method", async () => {
    const agreement = await jeffCaller().create({
      locationId: amparoId,
      serviceName: "Tattoo espalda",
      totalAgreedAmount: 300_000,
    });

    await expect(
      jeffCaller().addPayment({
        agreementId: agreement.id,
        paymentLines: [{ paymentMethodId: pmOtherBizId, amount: 50_000 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
