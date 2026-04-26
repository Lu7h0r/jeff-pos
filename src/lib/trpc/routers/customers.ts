import { z } from "zod/v4";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { eq, and, or } from "drizzle-orm";

const customerSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  status: z.string().nullable(),
  user_uid: z.string(),
  business_id: z.number().nullable(),
  created_at: z.date().nullable(),
});

export const customersRouter = router({
  // List customers visible to the user. When an active business is resolved
  // (Batch 1.5+), customers belonging to that business are visible OR
  // (legacy fallback) customers created by the user via user_uid. When no
  // active business is set, falls back to user_uid only — preserves
  // pre-business behaviour for tests and for users without membership.
  list: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/customers", tags: ["Customers"], summary: "List all customers" } })
    .input(z.void())
    .output(z.array(customerSchema))
    .query(async ({ ctx }) => {
      if (ctx.activeBusinessId != null) {
        return db
          .select()
          .from(customers)
          .where(
            or(
              eq(customers.business_id, ctx.activeBusinessId),
              eq(customers.user_uid, ctx.user.id),
            ),
          );
      }

      return db
        .select()
        .from(customers)
        .where(eq(customers.user_uid, ctx.user.id));
    }),

  create: protectedProcedure
    .meta({ openapi: { method: "POST", path: "/customers", tags: ["Customers"], summary: "Create a customer" } })
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        phone: z.string().optional(),
        status: z.enum(["active", "inactive"]).optional(),
      })
    )
    .output(customerSchema)
    .mutation(async ({ ctx, input }) => {
      const [data] = await db
        .insert(customers)
        .values({
          ...input,
          user_uid: ctx.user.id,
          business_id: ctx.activeBusinessId ?? null,
        })
        .returning();
      return data;
    }),

  update: protectedProcedure
    .meta({ openapi: { method: "PATCH", path: "/customers/{id}", tags: ["Customers"], summary: "Update a customer" } })
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        status: z.enum(["active", "inactive"]).optional(),
      })
    )
    .output(customerSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [updated] = await db
        .update(customers)
        .set({ ...data, user_uid: ctx.user.id })
        .where(and(eq(customers.id, id), eq(customers.user_uid, ctx.user.id)))
        .returning();
      return updated;
    }),

  delete: protectedProcedure
    .meta({ openapi: { method: "DELETE", path: "/customers/{id}", tags: ["Customers"], summary: "Delete a customer" } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .delete(customers)
        .where(and(eq(customers.id, input.id), eq(customers.user_uid, ctx.user.id)));
      return { success: true };
    }),
});
