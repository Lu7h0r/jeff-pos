import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import {
  purchaseOrders,
  purchaseItems,
  suppliers,
  locations,
  products,
  paymentMethods,
  cashSessions,
  cashMovements,
  inventoryBalances,
  inventoryMovements,
} from "@/lib/db/schema";
import { eq, and, inArray, desc, sql } from "drizzle-orm";

const purchaseStatusSchema = z.enum(["draft", "received", "cancelled"]);

const purchaseOrderSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  supplier_id: z.number().nullable(),
  status: purchaseStatusSchema,
  total_amount: z.number(),
  payment_method_id: z.number().nullable(),
  cash_session_id: z.number().nullable(),
  notes: z.string().nullable(),
  created_by_user_id: z.string(),
  created_at: z.date().nullable(),
  received_at: z.date().nullable(),
});

const purchaseItemSchema = z.object({
  id: z.number(),
  purchase_order_id: z.number(),
  product_id: z.number(),
  quantity: z.number(),
  unit_cost: z.number(),
  total_cost: z.number(),
  created_at: z.date().nullable(),
});

const purchaseOrderWithItemsSchema = purchaseOrderSchema.extend({
  items: z.array(purchaseItemSchema),
});

function requireBusiness(activeBusinessId: number | null): number {
  if (activeBusinessId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "An active business is required",
    });
  }
  return activeBusinessId;
}

export const purchasesRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/purchases",
        tags: ["Purchases"],
        summary: "List purchase orders of the active business",
      },
    })
    .input(
      z.object({
        locationId: z.number().int().positive().optional(),
        status: purchaseStatusSchema.optional(),
      }),
    )
    .output(z.array(purchaseOrderSchema))
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const conditions = [eq(purchaseOrders.business_id, businessId)];
      if (input.locationId !== undefined) {
        conditions.push(eq(purchaseOrders.location_id, input.locationId));
      }
      if (input.status !== undefined) {
        conditions.push(eq(purchaseOrders.status, input.status));
      }
      const rows = await db
        .select()
        .from(purchaseOrders)
        .where(and(...conditions))
        .orderBy(desc(purchaseOrders.id));
      return rows.map((row) => ({
        ...row,
        status: purchaseStatusSchema.parse(row.status),
      }));
    }),

  create: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/purchases",
        tags: ["Purchases"],
        summary: "Create a draft purchase order with items",
      },
    })
    .input(
      z.object({
        locationId: z.number().int().positive(),
        supplierId: z.number().int().positive().optional(),
        items: z
          .array(
            z.object({
              productId: z.number().int().positive(),
              quantity: z.number().int().positive(),
              unitCost: z.number().int().positive(),
            }),
          )
          .min(1),
        paymentMethodId: z.number().int().positive().optional(),
        cashSessionId: z.number().int().positive().optional(),
        notes: z.string().optional(),
      }),
    )
    .output(purchaseOrderWithItemsSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      const [loc] = await db
        .select()
        .from(locations)
        .where(eq(locations.id, input.locationId))
        .limit(1);
      if (!loc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Location not found",
        });
      }
      if (loc.business_id !== businessId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Location belongs to a different business",
        });
      }

      if (input.supplierId !== undefined) {
        const [supplier] = await db
          .select()
          .from(suppliers)
          .where(eq(suppliers.id, input.supplierId))
          .limit(1);
        if (!supplier) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Supplier not found",
          });
        }
        if (supplier.business_id !== businessId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Supplier belongs to a different business",
          });
        }
      }

      const productIds = Array.from(
        new Set(input.items.map((it) => it.productId)),
      );
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
        if (product.business_id !== businessId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `Product ${product.name} belongs to a different business`,
          });
        }
      }

      let session: typeof cashSessions.$inferSelect | null = null;
      let paymentMethod: typeof paymentMethods.$inferSelect | null = null;
      const total = input.items.reduce(
        (sum, it) => sum + it.quantity * it.unitCost,
        0,
      );

      if (input.cashSessionId !== undefined) {
        const [found] = await db
          .select()
          .from(cashSessions)
          .where(eq(cashSessions.id, input.cashSessionId))
          .limit(1);
        if (!found) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Cash session not found",
          });
        }
        if (found.business_id !== businessId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cash session belongs to a different business",
          });
        }
        if (found.status !== "open") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Cash session is closed",
          });
        }
        session = found;
      }

      if (input.paymentMethodId !== undefined) {
        const [pm] = await db
          .select()
          .from(paymentMethods)
          .where(eq(paymentMethods.id, input.paymentMethodId))
          .limit(1);
        if (!pm) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Payment method not found",
          });
        }
        if (pm.business_id != null && pm.business_id !== businessId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Payment method belongs to a different business",
          });
        }
        paymentMethod = pm;
      }

      // Cash classification heuristic (DA-9): same lowercased name match as
      // orders.create / expenses.entries.create. Documented inline.
      const isCashMethod =
        !!paymentMethod && paymentMethod.name.toLowerCase().includes("cash");

      return await db.transaction(async (tx) => {
        const [order] = await tx
          .insert(purchaseOrders)
          .values({
            business_id: businessId,
            location_id: loc.id,
            supplier_id: input.supplierId ?? null,
            status: "draft",
            total_amount: total,
            payment_method_id: input.paymentMethodId ?? null,
            cash_session_id: input.cashSessionId ?? null,
            notes: input.notes ?? null,
            created_by_user_id: ctx.user.id,
          })
          .returning();

        const insertedItems = await tx
          .insert(purchaseItems)
          .values(
            input.items.map((it) => ({
              purchase_order_id: order.id,
              product_id: it.productId,
              quantity: it.quantity,
              unit_cost: it.unitCost,
              total_cost: it.quantity * it.unitCost,
            })),
          )
          .returning();

        if (session && isCashMethod) {
          const [latest] = await tx
            .select({ balance_after: cashMovements.balance_after })
            .from(cashMovements)
            .where(eq(cashMovements.cash_session_id, session.id))
            .orderBy(desc(cashMovements.id))
            .limit(1);

          const balanceBefore =
            latest?.balance_after ?? session.opening_cash_amount;
          const balanceAfter = balanceBefore - total;

          await tx.insert(cashMovements).values({
            business_id: businessId,
            location_id: session.location_id,
            cash_session_id: session.id,
            type: "manual_out",
            payment_method_id: input.paymentMethodId ?? null,
            source_type: "purchase_order",
            source_id: order.id,
            amount: -total,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
            transaction_type: "negative",
            created_by_user_id: ctx.user.id,
            notes: input.notes ?? null,
          });

          await tx
            .update(cashSessions)
            .set({
              expected_cash_amount: session.expected_cash_amount - total,
            })
            .where(eq(cashSessions.id, session.id));
        }

        return {
          ...order,
          status: purchaseStatusSchema.parse(order.status),
          items: insertedItems,
        };
      });
    }),

  receive: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/purchases/{purchaseOrderId}/receive",
        tags: ["Purchases"],
        summary: "Receive a draft purchase order: increment stock + ledger",
      },
    })
    .input(z.object({ purchaseOrderId: z.number().int().positive() }))
    .output(purchaseOrderWithItemsSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      const [order] = await db
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .limit(1);
      if (!order) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Purchase order not found",
        });
      }
      if (order.business_id !== businessId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Purchase order belongs to a different business",
        });
      }
      if (order.status !== "draft") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot receive a purchase order in status ${order.status}`,
        });
      }

      const items = await db
        .select()
        .from(purchaseItems)
        .where(eq(purchaseItems.purchase_order_id, order.id));

      return await db.transaction(async (tx) => {
        for (const item of items) {
          const [existing] = await tx
            .select()
            .from(inventoryBalances)
            .where(
              and(
                eq(inventoryBalances.location_id, order.location_id),
                eq(inventoryBalances.product_id, item.product_id),
              ),
            )
            .limit(1);

          if (existing) {
            await tx
              .update(inventoryBalances)
              .set({
                quantity_on_hand: sql`${inventoryBalances.quantity_on_hand} + ${item.quantity}`,
                updated_at: new Date(),
              })
              .where(eq(inventoryBalances.id, existing.id));
          } else {
            await tx.insert(inventoryBalances).values({
              business_id: businessId,
              location_id: order.location_id,
              product_id: item.product_id,
              quantity_on_hand: item.quantity,
              quantity_reserved: 0,
            });
          }

          await tx.insert(inventoryMovements).values({
            business_id: businessId,
            location_id: order.location_id,
            product_id: item.product_id,
            quantity_delta: item.quantity,
            type: "purchase",
            source_type: "purchase_order",
            source_id: order.id,
            created_by_user_id: ctx.user.id,
            notes: null,
          });

          // Most-recent-purchase-price strategy: products.cost_amount is
          // overwritten with the latest unit_cost. Documented MVP choice;
          // weighted-average cost is parked for a later batch.
          await tx
            .update(products)
            .set({ cost_amount: item.unit_cost })
            .where(eq(products.id, item.product_id));
        }

        const [updated] = await tx
          .update(purchaseOrders)
          .set({ status: "received", received_at: new Date() })
          .where(eq(purchaseOrders.id, order.id))
          .returning();

        return {
          ...updated,
          status: purchaseStatusSchema.parse(updated.status),
          items,
        };
      });
    }),

  cancel: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/purchases/{purchaseOrderId}/cancel",
        tags: ["Purchases"],
        summary: "Cancel a draft purchase order (reverses any cash movement)",
      },
    })
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        reason: z.string().optional(),
      }),
    )
    .output(purchaseOrderWithItemsSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      const [order] = await db
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .limit(1);
      if (!order) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Purchase order not found",
        });
      }
      if (order.business_id !== businessId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Purchase order belongs to a different business",
        });
      }
      if (order.status !== "draft") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot cancel a purchase order in status ${order.status}`,
        });
      }

      const items = await db
        .select()
        .from(purchaseItems)
        .where(eq(purchaseItems.purchase_order_id, order.id));

      // Detect whether create wrote a cash_movement we need to reverse. We
      // look up by source_type/source_id rather than re-running the cash
      // heuristic so changes to payment method names later don't desync.
      const [originalMovement] = order.cash_session_id
        ? await db
            .select()
            .from(cashMovements)
            .where(
              and(
                eq(cashMovements.source_type, "purchase_order"),
                eq(cashMovements.source_id, order.id),
                eq(cashMovements.cash_session_id, order.cash_session_id),
              ),
            )
            .limit(1)
        : [];

      return await db.transaction(async (tx) => {
        if (originalMovement) {
          const [session] = await tx
            .select()
            .from(cashSessions)
            .where(eq(cashSessions.id, originalMovement.cash_session_id))
            .limit(1);

          if (session && session.status === "open") {
            const [latest] = await tx
              .select({ balance_after: cashMovements.balance_after })
              .from(cashMovements)
              .where(eq(cashMovements.cash_session_id, session.id))
              .orderBy(desc(cashMovements.id))
              .limit(1);
            const balanceBefore =
              latest?.balance_after ?? session.opening_cash_amount;
            // originalMovement.amount is negative (manual_out). Reversal is
            // positive cash back into the drawer.
            const reversalAmount = -originalMovement.amount;
            const balanceAfter = balanceBefore + reversalAmount;

            await tx.insert(cashMovements).values({
              business_id: order.business_id,
              location_id: session.location_id,
              cash_session_id: session.id,
              type: "manual_in",
              payment_method_id: originalMovement.payment_method_id,
              source_type: "purchase_order_cancel",
              source_id: order.id,
              amount: reversalAmount,
              balance_before: balanceBefore,
              balance_after: balanceAfter,
              transaction_type: "positive",
              created_by_user_id: ctx.user.id,
              notes: input.reason ?? null,
            });

            await tx
              .update(cashSessions)
              .set({
                expected_cash_amount:
                  session.expected_cash_amount + reversalAmount,
              })
              .where(eq(cashSessions.id, session.id));
          }
        }

        const [updated] = await tx
          .update(purchaseOrders)
          .set({
            status: "cancelled",
            notes: input.reason
              ? order.notes
                ? `${order.notes}\n${input.reason}`
                : input.reason
              : order.notes,
          })
          .where(eq(purchaseOrders.id, order.id))
          .returning();

        return {
          ...updated,
          status: purchaseStatusSchema.parse(updated.status),
          items,
        };
      });
    }),
});
