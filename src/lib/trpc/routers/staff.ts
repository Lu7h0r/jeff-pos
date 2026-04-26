import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { staffMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const staffKindSchema = z.enum([
  "artist",
  "apprentice",
  "piercer",
  "manager",
  "external",
]);

const splitKindSchema = z.enum([
  "staff_30_house_70",
  "staff_50_house_50",
  "staff_70_house_30",
  "owner_direct",
  "manual",
]);

const staffSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  user_id: z.string().nullable(),
  display_name: z.string(),
  kind: staffKindSchema,
  commission_rate: z.number(),
  default_split: splitKindSchema,
  archived: z.boolean(),
  notes: z.string().nullable(),
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

async function loadOwned(staffId: number, businessId: number) {
  const [row] = await db
    .select()
    .from(staffMembers)
    .where(eq(staffMembers.id, staffId))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Staff member not found",
    });
  }
  if (row.business_id !== businessId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Staff member belongs to a different business",
    });
  }
  return row;
}

function rowToOutput(row: typeof staffMembers.$inferSelect) {
  return {
    ...row,
    kind: staffKindSchema.parse(row.kind),
    default_split: splitKindSchema.parse(row.default_split),
  };
}

export const staffRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/staff",
        tags: ["Staff"],
        summary: "List non-archived staff members of the active business",
      },
    })
    .input(z.void())
    .output(z.array(staffSchema))
    .query(async ({ ctx }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const rows = await db
        .select()
        .from(staffMembers)
        .where(
          and(
            eq(staffMembers.business_id, businessId),
            eq(staffMembers.archived, false),
          ),
        )
        .orderBy(staffMembers.display_name);
      return rows.map(rowToOutput);
    }),

  create: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/staff",
        tags: ["Staff"],
        summary: "Create a staff member",
      },
    })
    .input(
      z.object({
        displayName: z.string().min(1).max(255),
        kind: staffKindSchema.optional(),
        commissionRate: z.number().int().min(0).max(10_000).optional(),
        defaultSplit: splitKindSchema.optional(),
        userId: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .output(staffSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const [created] = await db
        .insert(staffMembers)
        .values({
          business_id: businessId,
          user_id: input.userId ?? null,
          display_name: input.displayName.trim(),
          kind: input.kind ?? "artist",
          commission_rate: input.commissionRate ?? 0,
          default_split: input.defaultSplit ?? "staff_30_house_70",
          notes: input.notes ?? null,
        })
        .returning();
      return rowToOutput(created);
    }),

  update: protectedProcedure
    .meta({
      openapi: {
        method: "PATCH",
        path: "/staff/{id}",
        tags: ["Staff"],
        summary: "Update a staff member",
      },
    })
    .input(
      z.object({
        id: z.number().int().positive(),
        displayName: z.string().min(1).max(255).optional(),
        kind: staffKindSchema.optional(),
        commissionRate: z.number().int().min(0).max(10_000).optional(),
        defaultSplit: splitKindSchema.optional(),
        userId: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .output(staffSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      await loadOwned(input.id, businessId);

      const patch: Partial<typeof staffMembers.$inferInsert> = {};
      if (input.displayName !== undefined)
        patch.display_name = input.displayName.trim();
      if (input.kind !== undefined) patch.kind = input.kind;
      if (input.commissionRate !== undefined)
        patch.commission_rate = input.commissionRate;
      if (input.defaultSplit !== undefined)
        patch.default_split = input.defaultSplit;
      if (input.userId !== undefined) patch.user_id = input.userId;
      if (input.notes !== undefined) patch.notes = input.notes;

      const [updated] = await db
        .update(staffMembers)
        .set(patch)
        .where(eq(staffMembers.id, input.id))
        .returning();
      return rowToOutput(updated);
    }),

  archive: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/staff/{id}/archive",
        tags: ["Staff"],
        summary: "Archive a staff member (soft delete, idempotent)",
      },
    })
    .input(z.object({ id: z.number().int().positive() }))
    .output(staffSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      await loadOwned(input.id, businessId);

      const [updated] = await db
        .update(staffMembers)
        .set({ archived: true })
        .where(eq(staffMembers.id, input.id))
        .returning();
      return rowToOutput(updated);
    }),
});
