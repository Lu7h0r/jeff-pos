import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { ownerOrManager } from "../role-guards";
import { assertLocationAllowed } from "../scope-guards";
import { db } from "@/lib/db";
import {
  inventoryBalances,
  inventoryMovements,
  locations,
  products,
  businessMembers,
} from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";

// Allowed movement types accepted from clients in this batch. Reserved
// values (sale, refund, purchase) come with Batch 4/6 and are intentionally
// not exposed yet — the varchar(30) column accommodates them.
const adjustTypeSchema = z.enum(["adjustment", "internal_consumption"]);

const balanceRowSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  product_id: z.number(),
  quantity_on_hand: z.number(),
  quantity_reserved: z.number(),
  created_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

const balanceWithProductSchema = z.object({
  product_id: z.number(),
  product_name: z.string(),
  sku: z.string().nullable(),
  quantity_on_hand: z.number(),
  quantity_reserved: z.number(),
  location_id: z.number(),
});

const movementRowSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  product_id: z.number(),
  product_name: z.string(),
  quantity_delta: z.number(),
  type: z.string(),
  source_type: z.string().nullable(),
  source_id: z.number().nullable(),
  created_by_user_id: z.string(),
  notes: z.string().nullable(),
  created_at: z.date().nullable(),
});

/**
 * Resolve a location and validate that the user has active membership in
 * the location's business. Single source of truth for cross-business
 * isolation in this router (mirrors cash-sessions assertLocationAccess).
 */
async function assertLocationAccess(userId: string, locationId: number) {
  const [loc] = await db
    .select()
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1);

  if (!loc) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
  }

  const [membership] = await db
    .select({ id: businessMembers.id })
    .from(businessMembers)
    .where(
      and(
        eq(businessMembers.user_id, userId),
        eq(businessMembers.business_id, loc.business_id),
        eq(businessMembers.status, "active"),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of this business",
    });
  }

  return loc;
}

export const inventoryRouter = router({
  balancesByLocation: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/inventory/balances",
        tags: ["Inventory"],
        summary: "List inventory balances at a location",
      },
    })
    .input(z.object({ locationId: z.number().int().positive().optional() }))
    .output(z.array(balanceWithProductSchema))
    .query(async ({ ctx, input }) => {
      const resolved = input.locationId ?? ctx.activeLocationId ?? null;
      if (resolved == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No active location resolvable for this request",
        });
      }

      assertLocationAllowed(ctx, resolved);
      await assertLocationAccess(ctx.user.id, resolved);

      const rows = await db
        .select({
          product_id: inventoryBalances.product_id,
          product_name: products.name,
          sku: products.sku,
          quantity_on_hand: inventoryBalances.quantity_on_hand,
          quantity_reserved: inventoryBalances.quantity_reserved,
          location_id: inventoryBalances.location_id,
        })
        .from(inventoryBalances)
        .innerJoin(products, eq(products.id, inventoryBalances.product_id))
        .where(eq(inventoryBalances.location_id, resolved))
        .orderBy(products.name);

      return rows;
    }),

  adjust: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/inventory/adjust",
        tags: ["Inventory"],
        summary: "Adjust on-hand quantity at a location (signed delta)",
      },
    })
    .input(
      z.object({
        productId: z.number().int().positive(),
        locationId: z.number().int().positive(),
        quantityDelta: z.number().int(),
        type: adjustTypeSchema,
        notes: z.string().optional(),
      }),
    )
    .output(balanceRowSchema)
    .mutation(async ({ ctx, input }) => {
      assertLocationAllowed(ctx, input.locationId);
      const loc = await assertLocationAccess(ctx.user.id, input.locationId);

      const [product] = await db
        .select()
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);

      if (!product) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Product not found",
        });
      }

      if (product.business_id != null && product.business_id !== loc.business_id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Product belongs to a different business",
        });
      }

      if (input.quantityDelta === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "quantityDelta must be non-zero",
        });
      }

      return await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(inventoryBalances)
          .where(
            and(
              eq(inventoryBalances.location_id, loc.id),
              eq(inventoryBalances.product_id, input.productId),
            ),
          )
          .limit(1);

        let updated;
        if (existing) {
          const next = existing.quantity_on_hand + input.quantityDelta;
          if (next < 0) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Adjustment would leave quantity_on_hand below zero",
            });
          }
          [updated] = await tx
            .update(inventoryBalances)
            .set({ quantity_on_hand: next, updated_at: new Date() })
            .where(eq(inventoryBalances.id, existing.id))
            .returning();
        } else {
          if (input.quantityDelta < 0) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Cannot create a balance with a negative delta",
            });
          }
          [updated] = await tx
            .insert(inventoryBalances)
            .values({
              business_id: loc.business_id,
              location_id: loc.id,
              product_id: input.productId,
              quantity_on_hand: input.quantityDelta,
              quantity_reserved: 0,
            })
            .returning();
        }

        await tx.insert(inventoryMovements).values({
          business_id: loc.business_id,
          location_id: loc.id,
          product_id: input.productId,
          quantity_delta: input.quantityDelta,
          type: input.type,
          source_type: "manual",
          source_id: null,
          created_by_user_id: ctx.user.id,
          notes: input.notes ?? null,
        });

        return updated;
      });
    }),

  transfer: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/inventory/transfer",
        tags: ["Inventory"],
        summary: "Transfer stock between two locations of the same business",
      },
    })
    .input(
      z.object({
        productId: z.number().int().positive(),
        fromLocationId: z.number().int().positive(),
        toLocationId: z.number().int().positive(),
        quantity: z.number().int().positive(),
        notes: z.string().optional(),
      }),
    )
    .output(
      z.object({
        from: balanceRowSchema,
        to: balanceRowSchema,
        movementOutId: z.number(),
        movementInId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.fromLocationId === input.toLocationId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "fromLocationId and toLocationId must differ",
        });
      }

      assertLocationAllowed(ctx, input.fromLocationId);
      assertLocationAllowed(ctx, input.toLocationId);
      const fromLoc = await assertLocationAccess(ctx.user.id, input.fromLocationId);
      const toLoc = await assertLocationAccess(ctx.user.id, input.toLocationId);

      if (fromLoc.business_id !== toLoc.business_id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Locations belong to different businesses",
        });
      }

      const [product] = await db
        .select()
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);

      if (!product) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Product not found",
        });
      }

      if (product.business_id != null && product.business_id !== fromLoc.business_id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Product belongs to a different business",
        });
      }

      return await db.transaction(async (tx) => {
        const [fromBalance] = await tx
          .select()
          .from(inventoryBalances)
          .where(
            and(
              eq(inventoryBalances.location_id, fromLoc.id),
              eq(inventoryBalances.product_id, input.productId),
            ),
          )
          .limit(1);

        if (!fromBalance || fromBalance.quantity_on_hand < input.quantity) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Insufficient stock at source location",
          });
        }

        const [updatedFrom] = await tx
          .update(inventoryBalances)
          .set({
            quantity_on_hand: fromBalance.quantity_on_hand - input.quantity,
            updated_at: new Date(),
          })
          .where(eq(inventoryBalances.id, fromBalance.id))
          .returning();

        const [toBalance] = await tx
          .select()
          .from(inventoryBalances)
          .where(
            and(
              eq(inventoryBalances.location_id, toLoc.id),
              eq(inventoryBalances.product_id, input.productId),
            ),
          )
          .limit(1);

        let updatedTo;
        if (toBalance) {
          [updatedTo] = await tx
            .update(inventoryBalances)
            .set({
              quantity_on_hand: toBalance.quantity_on_hand + input.quantity,
              updated_at: new Date(),
            })
            .where(eq(inventoryBalances.id, toBalance.id))
            .returning();
        } else {
          [updatedTo] = await tx
            .insert(inventoryBalances)
            .values({
              business_id: toLoc.business_id,
              location_id: toLoc.id,
              product_id: input.productId,
              quantity_on_hand: input.quantity,
              quantity_reserved: 0,
            })
            .returning();
        }

        const [movementOut] = await tx
          .insert(inventoryMovements)
          .values({
            business_id: fromLoc.business_id,
            location_id: fromLoc.id,
            product_id: input.productId,
            quantity_delta: -input.quantity,
            type: "transfer_out",
            source_type: "transfer",
            source_id: null,
            created_by_user_id: ctx.user.id,
            notes: input.notes ?? null,
          })
          .returning();

        const [movementIn] = await tx
          .insert(inventoryMovements)
          .values({
            business_id: toLoc.business_id,
            location_id: toLoc.id,
            product_id: input.productId,
            quantity_delta: input.quantity,
            type: "transfer_in",
            source_type: "transfer",
            source_id: movementOut.id,
            created_by_user_id: ctx.user.id,
            notes: input.notes ?? null,
          })
          .returning();

        return {
          from: updatedFrom,
          to: updatedTo,
          movementOutId: movementOut.id,
          movementInId: movementIn.id,
        };
      });
    }),

  movements: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/inventory/movements",
        tags: ["Inventory"],
        summary: "List recent inventory movements for a location/product",
      },
    })
    .input(
      z.object({
        locationId: z.number().int().positive().optional(),
        productId: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    )
    .output(z.array(movementRowSchema))
    .query(async ({ ctx, input }) => {
      const resolved = input.locationId ?? ctx.activeLocationId ?? null;
      if (resolved == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No active location resolvable for this request",
        });
      }

      assertLocationAllowed(ctx, resolved);
      await assertLocationAccess(ctx.user.id, resolved);

      const conditions = [eq(inventoryMovements.location_id, resolved)];
      if (input.productId !== undefined) {
        conditions.push(eq(inventoryMovements.product_id, input.productId));
      }

      const rows = await db
        .select({
          id: inventoryMovements.id,
          business_id: inventoryMovements.business_id,
          location_id: inventoryMovements.location_id,
          product_id: inventoryMovements.product_id,
          product_name: products.name,
          quantity_delta: inventoryMovements.quantity_delta,
          type: inventoryMovements.type,
          source_type: inventoryMovements.source_type,
          source_id: inventoryMovements.source_id,
          created_by_user_id: inventoryMovements.created_by_user_id,
          notes: inventoryMovements.notes,
          created_at: inventoryMovements.created_at,
        })
        .from(inventoryMovements)
        .innerJoin(products, eq(products.id, inventoryMovements.product_id))
        .where(and(...conditions))
        .orderBy(desc(inventoryMovements.id))
        .limit(input.limit ?? 50);

      return rows;
    }),
});
