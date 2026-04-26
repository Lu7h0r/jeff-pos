import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { ownerOrManager } from "../role-guards";
import { db } from "@/lib/db";
import { workstations, locations } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { assertLocationAllowed } from "../scope-guards";

const workstationKindSchema = z.enum(["tattoo", "piercing", "general"]);

const workstationSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  name: z.string(),
  kind: workstationKindSchema,
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

async function assertLocation(locationId: number, businessId: number) {
  const [loc] = await db
    .select()
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1);
  if (!loc) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
  }
  if (loc.business_id !== businessId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Location belongs to a different business",
    });
  }
  return loc;
}

async function loadOwned(workstationId: number, businessId: number) {
  const [row] = await db
    .select()
    .from(workstations)
    .where(eq(workstations.id, workstationId))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Workstation not found",
    });
  }
  if (row.business_id !== businessId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Workstation belongs to a different business",
    });
  }
  return row;
}

function rowToOutput(row: typeof workstations.$inferSelect) {
  return { ...row, kind: workstationKindSchema.parse(row.kind) };
}

export const workstationsRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workstations",
        tags: ["Workstations"],
        summary: "List non-archived workstations of a location",
      },
    })
    .input(
      z.object({ locationId: z.number().int().positive().optional() }),
    )
    .output(z.array(workstationSchema))
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const locId = input.locationId ?? ctx.activeLocationId;
      const conditions = [
        eq(workstations.business_id, businessId),
        eq(workstations.archived, false),
      ];
      if (locId != null) {
        assertLocationAllowed(ctx, locId);
        conditions.push(eq(workstations.location_id, locId));
      } else if (
        ctx.isLocationScoped &&
        ctx.effectiveLocationIds.length > 0
      ) {
        conditions.push(
          inArray(workstations.location_id, ctx.effectiveLocationIds),
        );
      }
      const rows = await db
        .select()
        .from(workstations)
        .where(and(...conditions))
        .orderBy(workstations.name);
      return rows.map(rowToOutput);
    }),

  create: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/workstations",
        tags: ["Workstations"],
        summary: "Create a workstation",
      },
    })
    .input(
      z.object({
        locationId: z.number().int().positive(),
        name: z.string().min(1).max(100),
        kind: workstationKindSchema.optional(),
      }),
    )
    .output(workstationSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      assertLocationAllowed(ctx, input.locationId);
      await assertLocation(input.locationId, businessId);

      const [created] = await db
        .insert(workstations)
        .values({
          business_id: businessId,
          location_id: input.locationId,
          name: input.name.trim(),
          kind: input.kind ?? "tattoo",
        })
        .returning();
      return rowToOutput(created);
    }),

  update: ownerOrManager
    .meta({
      openapi: {
        method: "PATCH",
        path: "/workstations/{id}",
        tags: ["Workstations"],
        summary: "Update a workstation",
      },
    })
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(100).optional(),
        kind: workstationKindSchema.optional(),
      }),
    )
    .output(workstationSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const existing = await loadOwned(input.id, businessId);
      assertLocationAllowed(ctx, existing.location_id);

      const patch: Partial<typeof workstations.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.kind !== undefined) patch.kind = input.kind;

      const [updated] = await db
        .update(workstations)
        .set(patch)
        .where(eq(workstations.id, input.id))
        .returning();
      return rowToOutput(updated);
    }),

  archive: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/workstations/{id}/archive",
        tags: ["Workstations"],
        summary: "Archive a workstation (soft delete, idempotent)",
      },
    })
    .input(z.object({ id: z.number().int().positive() }))
    .output(workstationSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const existing = await loadOwned(input.id, businessId);
      assertLocationAllowed(ctx, existing.location_id);

      const [updated] = await db
        .update(workstations)
        .set({ archived: true })
        .where(eq(workstations.id, input.id))
        .returning();
      return rowToOutput(updated);
    }),
});
