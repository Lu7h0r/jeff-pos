import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { artistOrAbove, ownerOrManager } from "../role-guards";
import { db } from "@/lib/db";
import {
  serviceSales,
  commissionEstimates,
  staffMembers,
  orderItems,
  orders,
} from "@/lib/db/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { computeShares } from "../commission-split";

const serviceKindSchema = z.enum([
  "tattoo",
  "piercing",
  "touchup",
  "removal",
  "consultation",
  "other",
]);

const splitKindSchema = z.enum([
  "staff_30_house_70",
  "staff_50_house_50",
  "staff_70_house_30",
  "owner_direct",
  "manual",
]);

const commissionStatusSchema = z.enum([
  "estimated",
  "manual_pending",
  "liquidated",
  "voided",
]);

const serviceSaleSchema = z.object({
  id: z.number(),
  order_item_id: z.number(),
  staff_member_id: z.number(),
  service_kind: serviceKindSchema,
  body_location: z.string().nullable(),
  materials_used: z.string().nullable(),
  practitioner_notes: z.string().nullable(),
  commission_split: splitKindSchema,
  created_at: z.date().nullable(),
});

const serviceSaleListItemSchema = serviceSaleSchema.extend({
  order_id: z.number().nullable(),
  order_business_id: z.number(),
  order_location_id: z.number(),
  order_total_amount: z.number(),
  order_created_at: z.date().nullable(),
  staff_display_name: z.string(),
  product_name: z.string().nullable(),
  unit_price: z.number().nullable(),
  total_price: z.number().nullable(),
});

const commissionSchema = z.object({
  id: z.number(),
  service_sale_id: z.number(),
  staff_member_id: z.number(),
  business_id: z.number(),
  gross_amount: z.number(),
  staff_share_amount: z.number(),
  house_share_amount: z.number(),
  split_kind: splitKindSchema,
  status: commissionStatusSchema,
  liquidated_at: z.date().nullable(),
  liquidated_by_user_id: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.date().nullable(),
});

const commissionListItemSchema = commissionSchema.extend({
  staff_display_name: z.string(),
  staff_running_total: z.number(),
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

const commissionsRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/services/commissions",
        tags: ["Services"],
        summary: "List commission estimates with running totals per staff",
      },
    })
    .input(
      z.object({
        staffMemberId: z.number().int().positive().optional(),
        status: commissionStatusSchema.optional(),
        rangeFrom: z.date().optional(),
        rangeTo: z.date().optional(),
      }),
    )
    .output(z.array(commissionListItemSchema))
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const conditions = [eq(commissionEstimates.business_id, businessId)];
      if (input.staffMemberId !== undefined)
        conditions.push(
          eq(commissionEstimates.staff_member_id, input.staffMemberId),
        );
      if (input.status !== undefined)
        conditions.push(eq(commissionEstimates.status, input.status));
      if (input.rangeFrom !== undefined)
        conditions.push(gte(commissionEstimates.created_at, input.rangeFrom));
      if (input.rangeTo !== undefined)
        conditions.push(lte(commissionEstimates.created_at, input.rangeTo));

      const rows = await db
        .select({
          id: commissionEstimates.id,
          service_sale_id: commissionEstimates.service_sale_id,
          staff_member_id: commissionEstimates.staff_member_id,
          business_id: commissionEstimates.business_id,
          gross_amount: commissionEstimates.gross_amount,
          staff_share_amount: commissionEstimates.staff_share_amount,
          house_share_amount: commissionEstimates.house_share_amount,
          split_kind: commissionEstimates.split_kind,
          status: commissionEstimates.status,
          liquidated_at: commissionEstimates.liquidated_at,
          liquidated_by_user_id: commissionEstimates.liquidated_by_user_id,
          notes: commissionEstimates.notes,
          created_at: commissionEstimates.created_at,
          staff_display_name: staffMembers.display_name,
        })
        .from(commissionEstimates)
        .innerJoin(
          staffMembers,
          eq(staffMembers.id, commissionEstimates.staff_member_id),
        )
        .where(and(...conditions))
        .orderBy(commissionEstimates.id);

      // Running total per staff_member_id of staff_share_amount.
      const totals = new Map<number, number>();
      const enriched = rows.map((row) => {
        const prev = totals.get(row.staff_member_id) ?? 0;
        const next = prev + row.staff_share_amount;
        totals.set(row.staff_member_id, next);
        return {
          ...row,
          split_kind: splitKindSchema.parse(row.split_kind),
          status: commissionStatusSchema.parse(row.status),
          staff_running_total: next,
        };
      });
      return enriched;
    }),

  markLiquidated: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/services/commissions/{commissionEstimateId}/liquidate",
        tags: ["Services"],
        summary: "Mark a commission estimate as liquidated (manual transition)",
      },
    })
    .input(
      z.object({
        commissionEstimateId: z.number().int().positive(),
        notes: z.string().optional(),
      }),
    )
    .output(commissionSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const [row] = await db
        .select()
        .from(commissionEstimates)
        .where(eq(commissionEstimates.id, input.commissionEstimateId))
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Commission estimate not found",
        });
      }
      if (row.business_id !== businessId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Commission estimate belongs to a different business",
        });
      }
      if (row.status === "liquidated") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Commission estimate is already liquidated",
        });
      }

      const [updated] = await db
        .update(commissionEstimates)
        .set({
          status: "liquidated",
          liquidated_at: new Date(),
          liquidated_by_user_id: ctx.user.id,
          notes: input.notes ?? row.notes,
        })
        .where(eq(commissionEstimates.id, row.id))
        .returning();
      return {
        ...updated,
        split_kind: splitKindSchema.parse(updated.split_kind),
        status: commissionStatusSchema.parse(updated.status),
      };
    }),
});

export const servicesRouter = router({
  // attachToOrderItem links an existing order_item with the staff member who
  // performed the service. It does NOT create or modify orders/order_items.
  // Two writes inside a single tx: service_sales row + commission_estimates
  // row whose shares are computed from the snapshot of staff.default_split.
  attachToOrderItem: artistOrAbove
    .meta({
      openapi: {
        method: "POST",
        path: "/services/attach",
        tags: ["Services"],
        summary: "Attach a staff service to an existing order_item",
      },
    })
    .input(
      z.object({
        orderItemId: z.number().int().positive(),
        staffMemberId: z.number().int().positive(),
        serviceKind: serviceKindSchema,
        bodyLocation: z.string().max(100).optional(),
        materialsUsed: z.string().optional(),
        practitionerNotes: z.string().optional(),
      }),
    )
    .output(
      z.object({
        serviceSale: serviceSaleSchema,
        commissionEstimate: commissionSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      const [item] = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.id, input.orderItemId))
        .limit(1);
      if (!item) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Order item not found",
        });
      }
      if (item.order_id == null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Order item has no parent order",
        });
      }
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, item.order_id))
        .limit(1);
      if (!order) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Parent order not found",
        });
      }
      if (order.business_id !== businessId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Order belongs to a different business",
        });
      }

      const [staff] = await db
        .select()
        .from(staffMembers)
        .where(eq(staffMembers.id, input.staffMemberId))
        .limit(1);
      if (!staff) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Staff member not found",
        });
      }
      if (staff.business_id !== businessId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff member belongs to a different business",
        });
      }

      const splitKind = staff.default_split;
      const gross = item.total_price ?? item.price * item.quantity;
      const shares = computeShares(gross, splitKind);

      return await db.transaction(async (tx) => {
        const [sale] = await tx
          .insert(serviceSales)
          .values({
            order_item_id: item.id,
            staff_member_id: staff.id,
            service_kind: input.serviceKind,
            body_location: input.bodyLocation ?? null,
            materials_used: input.materialsUsed ?? null,
            practitioner_notes: input.practitionerNotes ?? null,
            commission_split: splitKind,
          })
          .returning();

        const [estimate] = await tx
          .insert(commissionEstimates)
          .values({
            service_sale_id: sale.id,
            staff_member_id: staff.id,
            business_id: businessId,
            gross_amount: gross,
            staff_share_amount: shares.staff,
            house_share_amount: shares.house,
            split_kind: splitKind,
            status: "estimated",
          })
          .returning();

        return {
          serviceSale: {
            ...sale,
            service_kind: serviceKindSchema.parse(sale.service_kind),
            commission_split: splitKindSchema.parse(sale.commission_split),
          },
          commissionEstimate: {
            ...estimate,
            split_kind: splitKindSchema.parse(estimate.split_kind),
            status: commissionStatusSchema.parse(estimate.status),
          },
        };
      });
    }),

  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/services",
        tags: ["Services"],
        summary: "List service sales joined with order/staff context",
      },
    })
    .input(
      z.object({
        rangeFrom: z.date().optional(),
        rangeTo: z.date().optional(),
        staffMemberId: z.number().int().positive().optional(),
        locationId: z.number().int().positive().optional(),
      }),
    )
    .output(z.array(serviceSaleListItemSchema))
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      const conditions = [eq(orders.business_id, businessId)];
      if (input.staffMemberId !== undefined)
        conditions.push(
          eq(serviceSales.staff_member_id, input.staffMemberId),
        );
      if (input.locationId !== undefined)
        conditions.push(eq(orders.location_id, input.locationId));
      if (input.rangeFrom !== undefined)
        conditions.push(gte(serviceSales.created_at, input.rangeFrom));
      if (input.rangeTo !== undefined)
        conditions.push(lte(serviceSales.created_at, input.rangeTo));

      const rows = await db
        .select({
          id: serviceSales.id,
          order_item_id: serviceSales.order_item_id,
          staff_member_id: serviceSales.staff_member_id,
          service_kind: serviceSales.service_kind,
          body_location: serviceSales.body_location,
          materials_used: serviceSales.materials_used,
          practitioner_notes: serviceSales.practitioner_notes,
          commission_split: serviceSales.commission_split,
          created_at: serviceSales.created_at,
          order_id: orderItems.order_id,
          order_business_id: orders.business_id,
          order_location_id: orders.location_id,
          order_total_amount: orders.total_amount,
          order_created_at: orders.created_at,
          staff_display_name: staffMembers.display_name,
          product_name: orderItems.product_name,
          unit_price: orderItems.unit_price,
          total_price: orderItems.total_price,
        })
        .from(serviceSales)
        .innerJoin(orderItems, eq(orderItems.id, serviceSales.order_item_id))
        .innerJoin(orders, eq(orders.id, orderItems.order_id))
        .innerJoin(
          staffMembers,
          eq(staffMembers.id, serviceSales.staff_member_id),
        )
        .where(and(...conditions))
        .orderBy(desc(serviceSales.id));

      return rows.map((r) => ({
        ...r,
        service_kind: serviceKindSchema.parse(r.service_kind),
        commission_split: splitKindSchema.parse(r.commission_split),
      }));
    }),

  commissions: commissionsRouter,
});

export { commissionsRouter };
