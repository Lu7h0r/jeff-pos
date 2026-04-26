import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { ownerOrManager } from "../role-guards";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const productSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  in_stock: z.number(),
  category: z.string().nullable(),
  user_uid: z.string(),
  created_at: z.date().nullable(),
});

export const productsRouter = router({
  list: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/products", tags: ["Products"], summary: "List all products" } })
    .input(z.void())
    .output(z.array(productSchema))
    .query(async ({ ctx }) => {
      return db.select().from(products).where(eq(products.user_uid, ctx.user.id));
    }),

  create: ownerOrManager
    .meta({ openapi: { method: "POST", path: "/products", tags: ["Products"], summary: "Create a product" } })
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        price: z.number().int(),
        in_stock: z.number().int().min(0),
        category: z.string().optional(),
      })
    )
    .output(productSchema)
    .mutation(async ({ ctx, input }) => {
      // Batch 4 / DA-7: products.business_id is now NOT NULL. Without an
      // active business the product cannot be tied to any catalogue, so the
      // request is rejected at the application layer (no silent fallback).
      if (ctx.activeBusinessId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "An active business is required to create products",
        });
      }
      const [data] = await db
        .insert(products)
        .values({
          ...input,
          user_uid: ctx.user.id,
          business_id: ctx.activeBusinessId,
        })
        .returning();
      return data;
    }),

  update: ownerOrManager
    .meta({ openapi: { method: "PATCH", path: "/products/{id}", tags: ["Products"], summary: "Update a product" } })
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        price: z.number().int().optional(),
        in_stock: z.number().int().min(0).optional(),
        category: z.string().optional(),
      })
    )
    .output(productSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [updated] = await db
        .update(products)
        .set({ ...data, user_uid: ctx.user.id })
        .where(and(eq(products.id, id), eq(products.user_uid, ctx.user.id)))
        .returning();
      return updated;
    }),

  delete: ownerOrManager
    .meta({ openapi: { method: "DELETE", path: "/products/{id}", tags: ["Products"], summary: "Delete a product" } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .delete(products)
        .where(and(eq(products.id, input.id), eq(products.user_uid, ctx.user.id)));
      return { success: true };
    }),
});
