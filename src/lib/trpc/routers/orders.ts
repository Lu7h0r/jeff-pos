import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import {
  orders,
  orderItems,
  orderPayments,
  customers,
  products,
  paymentMethods,
  locations,
  businessMembers,
  cashSessions,
  cashMovements,
  inventoryBalances,
  inventoryMovements,
} from "@/lib/db/schema";
import { eq, and, inArray, desc, sql } from "drizzle-orm";

// ── Allowed enum values (single source of truth at zod layer) ───────────────
const paymentStatusSchema = z.enum(["paid", "unpaid", "partially_paid"]);
const processStatusSchema = z.enum(["pending", "ongoing", "complete", "void"]);

const orderRowSchema = z.object({
  id: z.number(),
  customer_id: z.number().nullable(),
  total_amount: z.number(),
  user_uid: z.string(),
  business_id: z.number(),
  location_id: z.number(),
  cash_session_id: z.number(),
  payment_status: paymentStatusSchema,
  process_status: processStatusSchema,
  voidance_reason: z.string().nullable(),
  voided_at: z.date().nullable(),
  voided_by_user_id: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.date().nullable(),
});

const orderWithCustomerSchema = orderRowSchema.extend({
  customer: z.object({ name: z.string() }).nullable(),
});

const orderItemSchema = z.object({
  id: z.number(),
  order_id: z.number().nullable(),
  product_id: z.number().nullable(),
  quantity: z.number(),
  price: z.number(),
  product_name: z.string().nullable(),
  unit_price: z.number().nullable(),
  unit_cost: z.number().nullable(),
  total_price: z.number().nullable(),
  created_at: z.date().nullable(),
});

const orderPaymentSchema = z.object({
  id: z.number(),
  order_id: z.number(),
  payment_method_id: z.number(),
  cash_session_id: z.number(),
  amount: z.number(),
  created_by_user_id: z.string(),
  created_at: z.date().nullable(),
});

const orderFullSchema = orderWithCustomerSchema.extend({
  items: z.array(orderItemSchema),
  payments: z.array(orderPaymentSchema),
});

/**
 * Resolve an active membership for the user in a given business. Returns
 * the row on success, throws FORBIDDEN otherwise.
 */
async function assertMembership(userId: string, businessId: number) {
  const [m] = await db
    .select({ id: businessMembers.id })
    .from(businessMembers)
    .where(
      and(
        eq(businessMembers.user_id, userId),
        eq(businessMembers.business_id, businessId),
        eq(businessMembers.status, "active"),
      ),
    )
    .limit(1);

  if (!m) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of this business",
    });
  }

  return m;
}

export const ordersRouter = router({
  // List orders scoped to the user's active business when available,
  // falling back to user_uid for back-compat with pre-Batch-4 demo rows.
  list: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/orders", tags: ["Orders"], summary: "List all orders" } })
    .input(z.void())
    .output(z.array(orderWithCustomerSchema))
    .query(async ({ ctx }) => {
      const rows = ctx.activeBusinessId != null
        ? await db.query.orders.findMany({
            where: eq(orders.business_id, ctx.activeBusinessId),
            with: { customer: { columns: { name: true } } },
          })
        : await db.query.orders.findMany({
            where: eq(orders.user_uid, ctx.user.id),
            with: { customer: { columns: { name: true } } },
          });
      return rows.map((r) => ({
        ...r,
        payment_status: paymentStatusSchema.parse(r.payment_status),
        process_status: processStatusSchema.parse(r.process_status),
      }));
    }),

  get: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/orders/{id}", tags: ["Orders"], summary: "Get an order with items and payments" } })
    .input(z.object({ id: z.number().int().positive() }))
    .output(orderFullSchema)
    .query(async ({ ctx, input }) => {
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, input.id))
        .limit(1);
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }
      await assertMembership(ctx.user.id, order.business_id);

      const items = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.order_id, order.id));
      const payments = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.order_id, order.id));
      const customer = order.customer_id
        ? await db.query.customers.findFirst({
            where: eq(customers.id, order.customer_id),
            columns: { name: true },
          })
        : null;

      return {
        ...order,
        payment_status: paymentStatusSchema.parse(order.payment_status),
        process_status: processStatusSchema.parse(order.process_status),
        customer: customer ?? null,
        items,
        payments,
      };
    }),

  // Atomic POS sale. Closes DA-1 (server recomputes total) and DA-2 (stock
  // decremented in the same transaction). Validates membership, location,
  // open cash session, products of same business, stock at location, and
  // sum(payments) === computed total. All writes happen inside one
  // db.transaction so partial state is impossible.
  create: protectedProcedure
    .meta({ openapi: { method: "POST", path: "/orders", tags: ["Orders"], summary: "Create an atomic POS sale" } })
    .input(
      z.object({
        locationId: z.number().int().positive(),
        customerId: z.number().int().positive().optional(),
        items: z
          .array(
            z.object({
              productId: z.number().int().positive(),
              quantity: z.number().int().positive(),
            }),
          )
          .min(1),
        paymentLines: z
          .array(
            z.object({
              paymentMethodId: z.number().int().positive(),
              amount: z.number().int().positive(),
            }),
          )
          .min(1),
        notes: z.string().optional(),
      }),
    )
    .output(orderFullSchema)
    .mutation(async ({ ctx, input }) => {
      const [loc] = await db
        .select()
        .from(locations)
        .where(eq(locations.id, input.locationId))
        .limit(1);

      if (!loc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }

      await assertMembership(ctx.user.id, loc.business_id);

      const [openSession] = await db
        .select()
        .from(cashSessions)
        .where(
          and(
            eq(cashSessions.location_id, loc.id),
            eq(cashSessions.status, "open"),
          ),
        )
        .limit(1);

      if (!openSession) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "No open cash session for this location",
        });
      }

      const productIds = Array.from(new Set(input.items.map((i) => i.productId)));
      const productRows = await db
        .select()
        .from(products)
        .where(inArray(products.id, productIds));

      const productById = new Map(productRows.map((p) => [p.id, p]));

      for (const item of input.items) {
        const product = productById.get(item.productId);
        if (!product) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Product ${item.productId} not found`,
          });
        }
        if (product.business_id !== loc.business_id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `Product ${product.name} belongs to a different business`,
          });
        }
        if (product.status !== "active") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Product ${product.name} is not active and cannot be sold`,
          });
        }
      }

      const computedTotal = input.items.reduce((sum, item) => {
        const product = productById.get(item.productId)!;
        return sum + product.price * item.quantity;
      }, 0);

      const paymentsTotal = input.paymentLines.reduce(
        (sum, p) => sum + p.amount,
        0,
      );
      if (paymentsTotal !== computedTotal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Payments (${paymentsTotal}) do not match total (${computedTotal})`,
        });
      }

      const paymentMethodIds = Array.from(
        new Set(input.paymentLines.map((p) => p.paymentMethodId)),
      );
      const paymentMethodRows = await db
        .select()
        .from(paymentMethods)
        .where(inArray(paymentMethods.id, paymentMethodIds));
      const paymentMethodById = new Map(paymentMethodRows.map((p) => [p.id, p]));
      for (const pm of paymentMethodIds) {
        const found = paymentMethodById.get(pm);
        if (!found) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Payment method ${pm} not found`,
          });
        }
        if (
          found.business_id != null &&
          found.business_id !== loc.business_id
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Payment method belongs to a different business",
          });
        }
      }

      // Cash methods are detected by name === 'cash' (case-insensitive). The
      // current schema does not carry a flag column, so we follow the
      // documented MVP convention from PLAN.md and seed.ts: any payment
      // method whose lowercased name contains "cash" feeds expected_cash;
      // anything else feeds expected_digital.
      const isCashMethod = (id: number) => {
        const pm = paymentMethodById.get(id);
        return !!pm && pm.name.toLowerCase().includes("cash");
      };

      return await db.transaction(async (tx) => {
        // Race-safe stock decrement — guarded UPDATE returns 0 rows if
        // someone else just sold the last unit. PLAN.md Riesgo 3.
        for (const item of input.items) {
          const updated = await tx
            .update(inventoryBalances)
            .set({
              quantity_on_hand: sql`${inventoryBalances.quantity_on_hand} - ${item.quantity}`,
              updated_at: new Date(),
            })
            .where(
              and(
                eq(inventoryBalances.location_id, loc.id),
                eq(inventoryBalances.product_id, item.productId),
                sql`${inventoryBalances.quantity_on_hand} >= ${item.quantity}`,
              ),
            )
            .returning();

          if (updated.length === 0) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `Insufficient stock for product ${productById.get(item.productId)!.name}`,
            });
          }
        }

        const [orderRow] = await tx
          .insert(orders)
          .values({
            customer_id: input.customerId ?? null,
            total_amount: computedTotal,
            user_uid: ctx.user.id,
            business_id: loc.business_id,
            location_id: loc.id,
            cash_session_id: openSession.id,
            payment_status: "paid",
            process_status: "complete",
            notes: input.notes ?? null,
          })
          .returning();

        const insertedItems = await tx
          .insert(orderItems)
          .values(
            input.items.map((item) => {
              const product = productById.get(item.productId)!;
              const unitPrice = product.price;
              return {
                order_id: orderRow.id,
                product_id: item.productId,
                quantity: item.quantity,
                price: unitPrice,
                product_name: product.name,
                unit_price: unitPrice,
                unit_cost: product.cost_amount ?? null,
                total_price: unitPrice * item.quantity,
              };
            }),
          )
          .returning();

        for (const item of input.items) {
          await tx.insert(inventoryMovements).values({
            business_id: loc.business_id,
            location_id: loc.id,
            product_id: item.productId,
            quantity_delta: -item.quantity,
            type: "sale",
            source_type: "order",
            source_id: orderRow.id,
            created_by_user_id: ctx.user.id,
            notes: null,
          });
        }

        const insertedPayments = await tx
          .insert(orderPayments)
          .values(
            input.paymentLines.map((p) => ({
              order_id: orderRow.id,
              payment_method_id: p.paymentMethodId,
              cash_session_id: openSession.id,
              amount: p.amount,
              created_by_user_id: ctx.user.id,
            })),
          )
          .returning();

        // Per-payment cash_movements with running balance. Read the latest
        // movement for the session under the open transaction to derive
        // balance_before; fall back to opening_cash_amount when the session
        // has no movements yet.
        let cashAdded = 0;
        let digitalAdded = 0;
        for (const line of input.paymentLines) {
          const [latest] = await tx
            .select({ balance_after: cashMovements.balance_after })
            .from(cashMovements)
            .where(eq(cashMovements.cash_session_id, openSession.id))
            .orderBy(desc(cashMovements.id))
            .limit(1);

          const balanceBefore =
            latest?.balance_after ?? openSession.opening_cash_amount;
          const balanceAfter = balanceBefore + line.amount;

          await tx.insert(cashMovements).values({
            business_id: loc.business_id,
            location_id: loc.id,
            cash_session_id: openSession.id,
            type: "sale",
            payment_method_id: line.paymentMethodId,
            source_type: "order",
            source_id: orderRow.id,
            amount: line.amount,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
            transaction_type: "positive",
            created_by_user_id: ctx.user.id,
            notes: null,
          });

          if (isCashMethod(line.paymentMethodId)) {
            cashAdded += line.amount;
          } else {
            digitalAdded += line.amount;
          }
        }

        await tx
          .update(cashSessions)
          .set({
            expected_cash_amount:
              openSession.expected_cash_amount + cashAdded,
            expected_digital_amount:
              openSession.expected_digital_amount + digitalAdded,
          })
          .where(eq(cashSessions.id, openSession.id));

        const customer = orderRow.customer_id
          ? await tx.query.customers.findFirst({
              where: eq(customers.id, orderRow.customer_id),
              columns: { name: true },
            })
          : null;

        return {
          ...orderRow,
          payment_status: paymentStatusSchema.parse(orderRow.payment_status),
          process_status: processStatusSchema.parse(orderRow.process_status),
          customer: customer ?? null,
          items: insertedItems,
          payments: insertedPayments,
        };
      });
    }),

  // Void an order. Closes DA-3 — replaces the previous broken delete with a
  // soft mark + reversed inventory and cash movements, all in one tx.
  void: protectedProcedure
    .meta({ openapi: { method: "POST", path: "/orders/{orderId}/void", tags: ["Orders"], summary: "Void an order with reversal" } })
    .input(
      z.object({
        orderId: z.number().int().positive(),
        voidanceReason: z.string().min(3),
      }),
    )
    .output(orderFullSchema)
    .mutation(async ({ ctx, input }) => {
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);

      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      await assertMembership(ctx.user.id, order.business_id);

      if (order.process_status === "void") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Order is already voided",
        });
      }

      const [session] = await db
        .select()
        .from(cashSessions)
        .where(eq(cashSessions.id, order.cash_session_id))
        .limit(1);

      if (!session || session.status !== "open") {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Cannot void: the cash session for this order is closed. Reopen the session or adjust manually.",
        });
      }

      const items = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.order_id, order.id));
      const payments = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.order_id, order.id));

      const paymentMethodIds = Array.from(
        new Set(payments.map((p) => p.payment_method_id)),
      );
      const paymentMethodRows = paymentMethodIds.length
        ? await db
            .select()
            .from(paymentMethods)
            .where(inArray(paymentMethods.id, paymentMethodIds))
        : [];
      const paymentMethodById = new Map(
        paymentMethodRows.map((pm) => [pm.id, pm]),
      );
      const isCashMethod = (id: number) => {
        const pm = paymentMethodById.get(id);
        return !!pm && pm.name.toLowerCase().includes("cash");
      };

      return await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(orders)
          .set({
            process_status: "void",
            voidance_reason: input.voidanceReason,
            voided_at: new Date(),
            voided_by_user_id: ctx.user.id,
          })
          .where(eq(orders.id, order.id))
          .returning();

        for (const item of items) {
          if (item.product_id == null) continue;
          await tx
            .update(inventoryBalances)
            .set({
              quantity_on_hand: sql`${inventoryBalances.quantity_on_hand} + ${item.quantity}`,
              updated_at: new Date(),
            })
            .where(
              and(
                eq(inventoryBalances.location_id, order.location_id),
                eq(inventoryBalances.product_id, item.product_id),
              ),
            );

          await tx.insert(inventoryMovements).values({
            business_id: order.business_id,
            location_id: order.location_id,
            product_id: item.product_id,
            quantity_delta: item.quantity,
            type: "adjustment",
            source_type: "order_void",
            source_id: order.id,
            created_by_user_id: ctx.user.id,
            notes: input.voidanceReason,
          });
        }

        let cashRemoved = 0;
        let digitalRemoved = 0;
        for (const p of payments) {
          const [latest] = await tx
            .select({ balance_after: cashMovements.balance_after })
            .from(cashMovements)
            .where(eq(cashMovements.cash_session_id, session.id))
            .orderBy(desc(cashMovements.id))
            .limit(1);

          const balanceBefore =
            latest?.balance_after ?? session.opening_cash_amount;
          const balanceAfter = balanceBefore - p.amount;

          await tx.insert(cashMovements).values({
            business_id: order.business_id,
            location_id: order.location_id,
            cash_session_id: session.id,
            type: "refund",
            payment_method_id: p.payment_method_id,
            source_type: "order_void",
            source_id: order.id,
            amount: -p.amount,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
            transaction_type: "negative",
            created_by_user_id: ctx.user.id,
            notes: input.voidanceReason,
          });

          if (isCashMethod(p.payment_method_id)) {
            cashRemoved += p.amount;
          } else {
            digitalRemoved += p.amount;
          }
        }

        await tx
          .update(cashSessions)
          .set({
            expected_cash_amount:
              session.expected_cash_amount - cashRemoved,
            expected_digital_amount:
              session.expected_digital_amount - digitalRemoved,
          })
          .where(eq(cashSessions.id, session.id));

        const customer = updated.customer_id
          ? await tx.query.customers.findFirst({
              where: eq(customers.id, updated.customer_id),
              columns: { name: true },
            })
          : null;

        return {
          ...updated,
          payment_status: paymentStatusSchema.parse(updated.payment_status),
          process_status: processStatusSchema.parse(updated.process_status),
          customer: customer ?? null,
          items,
          payments,
        };
      });
    }),

  // Closes DA-8 — the old `orders.update` allowed total_amount/status
  // mutation with no audit trail. It is intentionally retired. The only
  // free-text field that can be edited after a sale is `notes`; total
  // and state changes must go through void + new sale.
  editNotes: protectedProcedure
    .meta({ openapi: { method: "PATCH", path: "/orders/{orderId}/notes", tags: ["Orders"], summary: "Edit notes on an existing order" } })
    .input(
      z.object({
        orderId: z.number().int().positive(),
        notes: z.string(),
      }),
    )
    .output(orderWithCustomerSchema)
    .mutation(async ({ ctx, input }) => {
      const [existing] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }
      await assertMembership(ctx.user.id, existing.business_id);

      const [updated] = await db
        .update(orders)
        .set({ notes: input.notes })
        .where(eq(orders.id, existing.id))
        .returning();

      const customer = updated.customer_id
        ? await db.query.customers.findFirst({
            where: eq(customers.id, updated.customer_id),
            columns: { name: true },
          })
        : null;

      return {
        ...updated,
        payment_status: paymentStatusSchema.parse(updated.payment_status),
        process_status: processStatusSchema.parse(updated.process_status),
        customer: customer ?? null,
      };
    }),
});
