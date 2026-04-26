import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { ownerOrManager } from "../role-guards";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const productKindSchema = z.enum(["product", "service"]);

// Mirrors service_sales.service_kind enum from services.ts. Kept in sync by
// hand because both routers live independently and zod v4 enums don't expose
// a clean re-export pattern that survives the openapi tag generator.
const serviceKindSchema = z.enum([
  "tattoo",
  "piercing",
  "touchup",
  "removal",
  "consultation",
  "other",
]);

const productSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  in_stock: z.number(),
  category: z.string().nullable(),
  user_uid: z.string(),
  kind: productKindSchema,
  default_service_kind: serviceKindSchema.nullable(),
  created_at: z.date().nullable(),
});

// Service products MUST carry a default_service_kind so the POS attach
// dialog can prefill it and so reports can group services without having to
// guess. Physical products MUST NOT carry one — keeping the field strictly
// scoped avoids ambiguity in the catalogue.
const createInputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    price: z.number().int(),
    in_stock: z.number().int().min(0),
    category: z.string().optional(),
    kind: productKindSchema.default("product"),
    default_service_kind: serviceKindSchema.optional(),
  })
  .refine(
    (v) => v.kind !== "service" || v.default_service_kind !== undefined,
    {
      message: "default_service_kind is required when kind is service",
      path: ["default_service_kind"],
    },
  )
  .refine(
    (v) => v.kind !== "product" || v.default_service_kind === undefined,
    {
      message: "default_service_kind is only allowed when kind is service",
      path: ["default_service_kind"],
    },
  );

const updateInputSchema = z
  .object({
    id: z.number(),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    price: z.number().int().optional(),
    in_stock: z.number().int().min(0).optional(),
    category: z.string().optional(),
    kind: productKindSchema.optional(),
    default_service_kind: serviceKindSchema.nullable().optional(),
  })
  .refine(
    (v) => v.kind !== "service" || v.default_service_kind != null,
    {
      message: "default_service_kind is required when switching to service",
      path: ["default_service_kind"],
    },
  );

export const productsRouter = router({
  list: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/products", tags: ["Products"], summary: "List all products" } })
    .input(z.void())
    .output(z.array(productSchema))
    .query(async ({ ctx }) => {
      const rows = await db
        .select()
        .from(products)
        .where(eq(products.user_uid, ctx.user.id));
      return rows.map((r) => ({
        ...r,
        kind: productKindSchema.parse(r.kind),
        default_service_kind:
          r.default_service_kind === null
            ? null
            : serviceKindSchema.parse(r.default_service_kind),
      }));
    }),

  create: ownerOrManager
    .meta({ openapi: { method: "POST", path: "/products", tags: ["Products"], summary: "Create a product" } })
    .input(createInputSchema)
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
          default_service_kind: input.default_service_kind ?? null,
          user_uid: ctx.user.id,
          business_id: ctx.activeBusinessId,
        })
        .returning();
      return {
        ...data,
        kind: productKindSchema.parse(data.kind),
        default_service_kind:
          data.default_service_kind === null
            ? null
            : serviceKindSchema.parse(data.default_service_kind),
      };
    }),

  update: ownerOrManager
    .meta({ openapi: { method: "PATCH", path: "/products/{id}", tags: ["Products"], summary: "Update a product" } })
    .input(updateInputSchema)
    .output(productSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [updated] = await db
        .update(products)
        .set({ ...data, user_uid: ctx.user.id })
        .where(and(eq(products.id, id), eq(products.user_uid, ctx.user.id)))
        .returning();
      return {
        ...updated,
        kind: productKindSchema.parse(updated.kind),
        default_service_kind:
          updated.default_service_kind === null
            ? null
            : serviceKindSchema.parse(updated.default_service_kind),
      };
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
