import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { locationMembers, locations, user } from "@/lib/db/schema";
import { eq, and, ne } from "drizzle-orm";

const roleSchema = z.enum(["cashier", "artist", "manager", "viewer"]);
const statusSchema = z.enum(["active", "suspended", "removed"]);

const memberSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  user_id: z.string(),
  role: roleSchema,
  status: statusSchema,
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

function rowToOutput(row: typeof locationMembers.$inferSelect) {
  return {
    ...row,
    role: roleSchema.parse(row.role),
    status: statusSchema.parse(row.status),
  };
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

async function loadOwned(memberId: number, businessId: number) {
  const [row] = await db
    .select()
    .from(locationMembers)
    .where(eq(locationMembers.id, memberId))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Location member not found",
    });
  }
  if (row.business_id !== businessId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Location member belongs to a different business",
    });
  }
  return row;
}

export const locationMembersRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/location-members",
        tags: ["LocationMembers"],
        summary: "List active location members of the active business",
      },
    })
    .input(
      z.object({ locationId: z.number().int().positive().optional() }),
    )
    .output(z.array(memberSchema))
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const conditions = [
        eq(locationMembers.business_id, businessId),
        ne(locationMembers.status, "removed"),
      ];
      if (input.locationId !== undefined) {
        conditions.push(eq(locationMembers.location_id, input.locationId));
      }
      const rows = await db
        .select()
        .from(locationMembers)
        .where(and(...conditions))
        .orderBy(locationMembers.id);
      return rows.map(rowToOutput);
    }),

  add: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/location-members",
        tags: ["LocationMembers"],
        summary: "Add a granular per-location member",
      },
    })
    .input(
      z.object({
        locationId: z.number().int().positive(),
        userId: z.string().min(1),
        role: roleSchema,
      }),
    )
    .output(memberSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      await assertLocation(input.locationId, businessId);

      const [usr] = await db
        .select()
        .from(user)
        .where(eq(user.id, input.userId))
        .limit(1);
      if (!usr) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      const [created] = await db
        .insert(locationMembers)
        .values({
          business_id: businessId,
          location_id: input.locationId,
          user_id: input.userId,
          role: input.role,
          status: "active",
        })
        .returning();
      return rowToOutput(created);
    }),

  update: protectedProcedure
    .meta({
      openapi: {
        method: "PATCH",
        path: "/location-members/{id}",
        tags: ["LocationMembers"],
        summary: "Update role or status of a location member",
      },
    })
    .input(
      z.object({
        id: z.number().int().positive(),
        role: roleSchema.optional(),
        status: statusSchema.optional(),
      }),
    )
    .output(memberSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      await loadOwned(input.id, businessId);

      const patch: Partial<typeof locationMembers.$inferInsert> = {};
      if (input.role !== undefined) patch.role = input.role;
      if (input.status !== undefined) patch.status = input.status;

      const [updated] = await db
        .update(locationMembers)
        .set(patch)
        .where(eq(locationMembers.id, input.id))
        .returning();
      return rowToOutput(updated);
    }),

  remove: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/location-members/{id}/remove",
        tags: ["LocationMembers"],
        summary: "Soft-remove a location member (status=removed)",
      },
    })
    .input(z.object({ id: z.number().int().positive() }))
    .output(memberSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      await loadOwned(input.id, businessId);

      const [updated] = await db
        .update(locationMembers)
        .set({ status: "removed" })
        .where(eq(locationMembers.id, input.id))
        .returning();
      return rowToOutput(updated);
    }),
});
