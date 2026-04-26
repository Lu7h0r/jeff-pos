import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { suppliers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const supplierSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  name: z.string(),
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
  notes: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.date().nullable(),
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

async function loadOwnedSupplier(supplierId: number, businessId: number) {
  const [row] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Supplier not found" });
  }
  if (row.business_id !== businessId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Supplier belongs to a different business",
    });
  }
  return row;
}

export const suppliersRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/suppliers",
        tags: ["Suppliers"],
        summary: "List non-archived suppliers of the active business",
      },
    })
    .input(z.void())
    .output(z.array(supplierSchema))
    .query(async ({ ctx }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      return db
        .select()
        .from(suppliers)
        .where(
          and(
            eq(suppliers.business_id, businessId),
            eq(suppliers.archived, false),
          ),
        )
        .orderBy(suppliers.name);
    }),

  create: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/suppliers",
        tags: ["Suppliers"],
        summary: "Create a supplier",
      },
    })
    .input(
      z.object({
        name: z.string().min(1).max(255),
        contactEmail: z.string().email().optional(),
        contactPhone: z.string().max(50).optional(),
        notes: z.string().optional(),
      }),
    )
    .output(supplierSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const [created] = await db
        .insert(suppliers)
        .values({
          business_id: businessId,
          name: input.name.trim(),
          contact_email: input.contactEmail ?? null,
          contact_phone: input.contactPhone ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      return created;
    }),

  update: protectedProcedure
    .meta({
      openapi: {
        method: "PATCH",
        path: "/suppliers/{id}",
        tags: ["Suppliers"],
        summary: "Update a supplier",
      },
    })
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        contactEmail: z.string().email().nullable().optional(),
        contactPhone: z.string().max(50).nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .output(supplierSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      await loadOwnedSupplier(input.id, businessId);

      const patch: Partial<typeof suppliers.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.contactEmail !== undefined)
        patch.contact_email = input.contactEmail;
      if (input.contactPhone !== undefined)
        patch.contact_phone = input.contactPhone;
      if (input.notes !== undefined) patch.notes = input.notes;

      const [updated] = await db
        .update(suppliers)
        .set(patch)
        .where(eq(suppliers.id, input.id))
        .returning();
      return updated;
    }),

  archive: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/suppliers/{id}/archive",
        tags: ["Suppliers"],
        summary: "Archive a supplier (idempotent)",
      },
    })
    .input(z.object({ id: z.number().int().positive() }))
    .output(supplierSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      await loadOwnedSupplier(input.id, businessId);

      const [updated] = await db
        .update(suppliers)
        .set({ archived: true })
        .where(eq(suppliers.id, input.id))
        .returning();
      return updated;
    }),
});
