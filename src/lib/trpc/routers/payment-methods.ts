import { z } from "zod/v4";
import { protectedProcedure, router } from "../init";
import { ownerOrManager } from "../role-guards";
import { db } from "@/lib/db";
import { paymentMethods } from "@/lib/db/schema";
import { eq, or, isNull } from "drizzle-orm";

const paymentMethodSchema = z.object({
  id: z.number(),
  name: z.string(),
  business_id: z.number().nullable(),
  created_at: z.date().nullable(),
});

export const paymentMethodsRouter = router({
  // Visibility rules:
  // - Methods with business_id IS NULL are GLOBAL (cash, generic transfer).
  // - Methods with business_id are scoped to that business.
  // When an active business is resolved, returns globals + business methods.
  // When not, returns all (preserves pre-business behaviour).
  list: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/payment-methods", tags: ["Payment Methods"], summary: "List all payment methods" } })
    .input(z.void())
    .output(z.array(paymentMethodSchema))
    .query(async ({ ctx }) => {
      if (ctx.activeBusinessId != null) {
        return db
          .select()
          .from(paymentMethods)
          .where(
            or(
              isNull(paymentMethods.business_id),
              eq(paymentMethods.business_id, ctx.activeBusinessId),
            ),
          );
      }

      return db.select().from(paymentMethods);
    }),

  create: ownerOrManager
    .meta({ openapi: { method: "POST", path: "/payment-methods", tags: ["Payment Methods"], summary: "Create a payment method" } })
    .input(z.object({ name: z.string().min(1) }))
    .output(paymentMethodSchema)
    .mutation(async ({ ctx, input }) => {
      const [data] = await db
        .insert(paymentMethods)
        .values({
          name: input.name.trim(),
          business_id: ctx.activeBusinessId ?? null,
        })
        .returning();
      return data;
    }),

  update: ownerOrManager
    .meta({ openapi: { method: "PATCH", path: "/payment-methods/{id}", tags: ["Payment Methods"], summary: "Update a payment method" } })
    .input(z.object({ id: z.number(), name: z.string().min(1) }))
    .output(paymentMethodSchema)
    .mutation(async ({ input }) => {
      const [data] = await db
        .update(paymentMethods)
        .set({ name: input.name.trim() })
        .where(eq(paymentMethods.id, input.id))
        .returning();
      return data;
    }),

  delete: ownerOrManager
    .meta({ openapi: { method: "DELETE", path: "/payment-methods/{id}", tags: ["Payment Methods"], summary: "Delete a payment method" } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.delete(paymentMethods).where(eq(paymentMethods.id, input.id));
      return { success: true };
    }),
});
