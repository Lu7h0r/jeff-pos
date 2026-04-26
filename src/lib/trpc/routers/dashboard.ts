import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import {
  businesses,
  locations,
  cashSessions,
  orders,
  orderPayments,
  paymentMethods,
  inventoryBalances,
  products,
} from "@/lib/db/schema";
import { eq, and, gte, lte, desc, asc, lt, sql, inArray } from "drizzle-orm";
import { assertLocationAllowed } from "../scope-guards";

// Threshold for "low stock" alerts. Hardcoded for MVP — when expenses/config
// lands (Batch 6+) this should become a per-business setting.
const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_LIST_LIMIT = 10;

const cashSessionStatusSchema = z.enum(["open", "closed", "none"]);

const dashboardStatsOutput = z.object({
  business: z.object({
    id: z.number(),
    name: z.string(),
    slug: z.string(),
  }),
  scope: z.object({
    locationId: z.number().nullable(),
    rangeFrom: z.date(),
    rangeTo: z.date(),
  }),
  cashSession: z.object({
    status: cashSessionStatusSchema,
    openedAt: z.date().nullable(),
    expectedCash: z.number(),
    expectedDigital: z.number(),
    countedCash: z.number().nullable(),
    difference: z.number().nullable(),
  }),
  sales: z.object({
    todayCount: z.number(),
    todayRevenue: z.number(),
    voidedCount: z.number(),
    voidedRevenue: z.number(),
    byPaymentMethod: z.array(
      z.object({
        paymentMethodId: z.number(),
        name: z.string(),
        total: z.number(),
      }),
    ),
  }),
  inventory: z.object({
    lowStockCount: z.number(),
    lowStock: z.array(
      z.object({
        productId: z.number(),
        productName: z.string(),
        locationId: z.number(),
        locationName: z.string(),
        quantityOnHand: z.number(),
      }),
    ),
  }),
  expensesPlaceholder: z.object({
    note: z.string(),
    monthTotal: z.number(),
  }),
});

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export const dashboardRouter = router({
  stats: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/dashboard/stats",
        tags: ["Dashboard"],
        summary: "Per-location operational dashboard scoped to active business",
      },
    })
    .input(
      z.object({
        locationId: z.number().int().positive().optional(),
        rangeFrom: z.date().optional(),
        rangeTo: z.date().optional(),
      }),
    )
    .output(dashboardStatsOutput)
    .query(async ({ ctx, input }) => {
      if (ctx.activeBusinessId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No active business for this request",
        });
      }
      const businessId = ctx.activeBusinessId;

      const [biz] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);

      if (!biz) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Active business not found",
        });
      }

      let scopedLocationId: number | null = null;
      if (input.locationId !== undefined) {
        assertLocationAllowed(ctx, input.locationId);
        const [loc] = await db
          .select()
          .from(locations)
          .where(eq(locations.id, input.locationId))
          .limit(1);
        if (!loc || loc.business_id !== businessId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Location does not belong to active business",
          });
        }
        scopedLocationId = loc.id;
      }

      // DA-25: when a granular user does not pass an explicit locationId,
      // the aggregation must still be limited to their effective scope —
      // otherwise dashboard.stats would silently leak totals from other
      // sedes. We collapse the granular scope into the existing
      // `scopedLocationId` path when there is exactly one location, and
      // otherwise carry the full list through `scopedLocationIds`.
      const granularScopeIds: number[] | null =
        ctx.isLocationScoped && input.locationId === undefined
          ? ctx.effectiveLocationIds
          : null;

      const rangeFrom = input.rangeFrom ?? startOfToday();
      const rangeTo = input.rangeTo ?? new Date();

      // Cash session info. Only meaningful when locationId is provided —
      // a cross-location summary cannot collapse multiple drawers into one
      // status, so we return a documented "none" stub when locationId is
      // omitted (caller-side guidance: pick a location to see drawer state).
      let cashSessionStatus: "open" | "closed" | "none" = "none";
      let openedAt: Date | null = null;
      let expectedCash = 0;
      let expectedDigital = 0;
      let countedCash: number | null = null;
      let difference: number | null = null;

      if (scopedLocationId != null) {
        const [openSession] = await db
          .select()
          .from(cashSessions)
          .where(
            and(
              eq(cashSessions.business_id, businessId),
              eq(cashSessions.location_id, scopedLocationId),
              eq(cashSessions.status, "open"),
            ),
          )
          .orderBy(desc(cashSessions.id))
          .limit(1);

        const session =
          openSession ??
          (
            await db
              .select()
              .from(cashSessions)
              .where(
                and(
                  eq(cashSessions.business_id, businessId),
                  eq(cashSessions.location_id, scopedLocationId),
                ),
              )
              .orderBy(desc(cashSessions.id))
              .limit(1)
          )[0];

        if (session) {
          cashSessionStatus = session.status === "open" ? "open" : "closed";
          openedAt = session.opened_at;
          expectedCash = session.expected_cash_amount;
          expectedDigital = session.expected_digital_amount;
          countedCash = session.counted_cash_amount;
          difference = session.difference_amount;
        }
      }

      const orderScope = [
        eq(orders.business_id, businessId),
        gte(orders.created_at, rangeFrom),
        lte(orders.created_at, rangeTo),
      ];
      if (scopedLocationId != null) {
        orderScope.push(eq(orders.location_id, scopedLocationId));
      } else if (granularScopeIds && granularScopeIds.length > 0) {
        orderScope.push(inArray(orders.location_id, granularScopeIds));
      }

      const completeAgg = await db
        .select({
          count: sql<number>`count(*)::int`,
          revenue: sql<number>`coalesce(sum(${orders.total_amount}), 0)::int`,
        })
        .from(orders)
        .where(and(...orderScope, eq(orders.process_status, "complete")));

      const voidedAgg = await db
        .select({
          count: sql<number>`count(*)::int`,
          revenue: sql<number>`coalesce(sum(${orders.total_amount}), 0)::int`,
        })
        .from(orders)
        .where(and(...orderScope, eq(orders.process_status, "void")));

      // By payment method: join order_payments → orders → payment_methods,
      // restricted to complete orders within range. Voided payments are
      // excluded so the breakdown reflects what actually counts as revenue.
      const byPaymentRaw = await db
        .select({
          paymentMethodId: orderPayments.payment_method_id,
          name: paymentMethods.name,
          total: sql<number>`coalesce(sum(${orderPayments.amount}), 0)::int`,
        })
        .from(orderPayments)
        .innerJoin(orders, eq(orders.id, orderPayments.order_id))
        .innerJoin(
          paymentMethods,
          eq(paymentMethods.id, orderPayments.payment_method_id),
        )
        .where(and(...orderScope, eq(orders.process_status, "complete")))
        .groupBy(orderPayments.payment_method_id, paymentMethods.name)
        .orderBy(paymentMethods.name);

      const lowStockBaseScope = [
        eq(inventoryBalances.business_id, businessId),
        lt(inventoryBalances.quantity_on_hand, LOW_STOCK_THRESHOLD),
      ];
      if (scopedLocationId != null) {
        lowStockBaseScope.push(
          eq(inventoryBalances.location_id, scopedLocationId),
        );
      } else if (granularScopeIds && granularScopeIds.length > 0) {
        lowStockBaseScope.push(
          inArray(inventoryBalances.location_id, granularScopeIds),
        );
      }

      const lowStockCountRow = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(inventoryBalances)
        .where(and(...lowStockBaseScope));

      const lowStockRows = await db
        .select({
          productId: inventoryBalances.product_id,
          productName: products.name,
          locationId: inventoryBalances.location_id,
          locationName: locations.name,
          quantityOnHand: inventoryBalances.quantity_on_hand,
        })
        .from(inventoryBalances)
        .innerJoin(products, eq(products.id, inventoryBalances.product_id))
        .innerJoin(locations, eq(locations.id, inventoryBalances.location_id))
        .where(and(...lowStockBaseScope))
        .orderBy(asc(inventoryBalances.quantity_on_hand))
        .limit(LOW_STOCK_LIST_LIMIT);

      return {
        business: { id: biz.id, name: biz.name, slug: biz.slug },
        scope: {
          locationId: scopedLocationId,
          rangeFrom,
          rangeTo,
        },
        cashSession: {
          status: cashSessionStatus,
          openedAt,
          expectedCash,
          expectedDigital,
          countedCash,
          difference,
        },
        sales: {
          todayCount: completeAgg[0]?.count ?? 0,
          todayRevenue: completeAgg[0]?.revenue ?? 0,
          voidedCount: voidedAgg[0]?.count ?? 0,
          voidedRevenue: voidedAgg[0]?.revenue ?? 0,
          byPaymentMethod: byPaymentRaw,
        },
        inventory: {
          lowStockCount: lowStockCountRow[0]?.count ?? 0,
          lowStock: lowStockRows,
        },
        expensesPlaceholder: {
          note: "Wired in Batch 6",
          monthTotal: 0,
        },
      };
    }),
});
