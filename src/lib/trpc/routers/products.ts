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
  cost_amount: z.number().nullable(),
  image_url: z.string().nullable(),
  image_urls: z.array(z.string().url()),
  user_uid: z.string(),
  kind: productKindSchema,
  default_service_kind: serviceKindSchema.nullable(),
  created_at: z.date().nullable(),
});

function parseImageUrls(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function toProductOutput(
  row: typeof products.$inferSelect,
): z.infer<typeof productSchema> {
  return {
    ...row,
    cost_amount: row.cost_amount ?? null,
    image_url: row.image_url ?? null,
    image_urls: parseImageUrls(row.image_urls_json),
    kind: productKindSchema.parse(row.kind),
    default_service_kind:
      row.default_service_kind === null
        ? null
        : serviceKindSchema.parse(row.default_service_kind),
  };
}

// Service products MUST carry a default_service_kind so the POS attach
// dialog can prefill it and so reports can group services without having to
// guess. Physical products MUST NOT carry one — keeping the field strictly
// scoped avoids ambiguity in the catalogue.
const createInputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    price: z.number().int(),
    cost_amount: z.number().int().min(0).optional(),
    in_stock: z.number().int().min(0),
    category: z.string().optional(),
    image_url: z.string().url().optional(),
    image_urls: z.array(z.string().url()).max(8).optional(),
    kind: productKindSchema.default("product"),
    default_service_kind: serviceKindSchema.optional(),
  })
  .refine((v) => v.price >= 0, {
    message: "price must be >= 0",
    path: ["price"],
  })
  .refine((v) => (v.cost_amount ?? 0) <= v.price, {
    message: "cost_amount cannot exceed price",
    path: ["cost_amount"],
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
    cost_amount: z.number().int().min(0).nullable().optional(),
    in_stock: z.number().int().min(0).optional(),
    category: z.string().optional(),
    image_url: z.string().url().nullable().optional(),
    image_urls: z.array(z.string().url()).max(8).optional(),
    kind: productKindSchema.optional(),
    default_service_kind: serviceKindSchema.nullable().optional(),
  })
  .refine(
    (v) => v.kind !== "service" || v.default_service_kind != null,
    {
      message: "default_service_kind is required when switching to service",
      path: ["default_service_kind"],
    },
  )
  .refine(
    (v) => {
      const nextPrice = v.price;
      const nextCost = v.cost_amount;
      if (nextPrice === undefined || nextCost === undefined || nextCost === null) {
        return true;
      }
      return nextCost <= nextPrice;
    },
    {
      message: "cost_amount cannot exceed price",
      path: ["cost_amount"],
    },
  );

export const productsRouter = router({
  list: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/products", tags: ["Products"], summary: "List all products" } })
    .input(z.void())
    .output(z.array(productSchema))
    .query(async ({ ctx }) => {
      if (ctx.activeBusinessId == null) return [];
      const rows = await db
        .select()
        .from(products)
        .where(eq(products.business_id, ctx.activeBusinessId));
      return rows.map((r) => toProductOutput(r));
    }),

  create: ownerOrManager
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
          name: input.name,
          description: input.description,
          price: input.price,
          cost_amount: input.cost_amount ?? null,
          in_stock: input.in_stock,
          category: input.category,
          kind: input.kind,
          image_urls_json: JSON.stringify(input.image_urls ?? []),
          image_url: input.image_url ?? input.image_urls?.[0] ?? null,
          default_service_kind: input.default_service_kind ?? null,
          user_uid: ctx.user.id,
          business_id: ctx.activeBusinessId,
        })
        .returning();
      return toProductOutput(data);
    }),

  update: ownerOrManager
    .input(updateInputSchema)
    .output(productSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const nextImageUrls =
        data.image_urls === undefined ? undefined : JSON.stringify(data.image_urls);
      const nextImageUrl =
        data.image_url === undefined
          ? undefined
          : data.image_url ?? data.image_urls?.[0] ?? null;
      const updatePayload = {
        name: data.name,
        description: data.description,
        price: data.price,
        cost_amount: data.cost_amount,
        in_stock: data.in_stock,
        category: data.category,
        kind: data.kind,
        default_service_kind: data.default_service_kind,
        image_urls_json: nextImageUrls,
        image_url: nextImageUrl,
      };
      if (ctx.activeBusinessId == null)
        throw new TRPCError({ code: "FORBIDDEN", message: "No active business" });
      const [updated] = await db
        .update(products)
        .set(updatePayload)
        .where(and(eq(products.id, id), eq(products.business_id, ctx.activeBusinessId)))
        .returning();
      if (!updated)
        throw new TRPCError({ code: "NOT_FOUND", message: "Product not found" });
      return toProductOutput(updated);
    }),

  delete: ownerOrManager
    .meta({ openapi: { method: "DELETE", path: "/products/{id}", tags: ["Products"], summary: "Delete a product" } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.activeBusinessId == null)
        throw new TRPCError({ code: "FORBIDDEN", message: "No active business" });
      await db
        .delete(products)
        .where(and(eq(products.id, input.id), eq(products.business_id, ctx.activeBusinessId)));
      return { success: true };
    }),
});
