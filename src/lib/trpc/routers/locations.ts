import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { locations, businessMembers, locationMembers } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";

const locationSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  created_at: z.date().nullable(),
});

/**
 * Resolves the user's effective scope for cross-business isolation:
 *
 *   - businessIds: every business the user can see (via business_members
 *     for broad members, or derived from location_members for granular ones).
 *   - scopedLocationIds: when not null, restricts visible locations to those
 *     IDs (granular per-location auth, closes DA-15). When null, the user has
 *     broad business access and all active locations of the listed businesses
 *     are visible.
 *
 * Granular members never coexist with broad members in normal flows
 * (team.invite enforces the rule). When both kinds of rows exist for the
 * same user, broad wins to err on the safe side.
 */
async function userScope(userId: string): Promise<{
  businessIds: number[];
  scopedLocationIds: number[] | null;
}> {
  const broadRows = await db
    .select({ business_id: businessMembers.business_id })
    .from(businessMembers)
    .where(
      and(
        eq(businessMembers.user_id, userId),
        eq(businessMembers.status, "active"),
      ),
    );

  if (broadRows.length > 0) {
    return {
      businessIds: broadRows.map((row) => row.business_id),
      scopedLocationIds: null,
    };
  }

  const granularRows = await db
    .select({
      business_id: locationMembers.business_id,
      location_id: locationMembers.location_id,
    })
    .from(locationMembers)
    .where(
      and(
        eq(locationMembers.user_id, userId),
        eq(locationMembers.status, "active"),
      ),
    );

  if (granularRows.length > 0) {
    return {
      businessIds: Array.from(
        new Set(granularRows.map((row) => row.business_id)),
      ),
      scopedLocationIds: granularRows.map((row) => row.location_id),
    };
  }

  return { businessIds: [], scopedLocationIds: null };
}

export const locationsRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/locations",
        tags: ["Locations"],
        summary: "List active locations for the user's businesses",
      },
    })
    .input(z.void())
    .output(z.array(locationSchema))
    .query(async ({ ctx }) => {
      const { businessIds, scopedLocationIds } = await userScope(ctx.user.id);
      if (businessIds.length === 0) return [];

      const conditions = [
        inArray(locations.business_id, businessIds),
        eq(locations.status, "active"),
      ];
      if (scopedLocationIds !== null && scopedLocationIds.length > 0) {
        conditions.push(inArray(locations.id, scopedLocationIds));
      }

      return db
        .select()
        .from(locations)
        .where(and(...conditions))
        .orderBy(locations.id);
    }),

  getActive: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/locations/active",
        tags: ["Locations"],
        summary: "Resolve the active location for the user (optional id hint)",
      },
    })
    .input(z.object({ locationId: z.number().optional() }))
    .output(locationSchema.nullable())
    .query(async ({ ctx, input }) => {
      const { businessIds, scopedLocationIds } = await userScope(ctx.user.id);
      if (businessIds.length === 0) return null;

      if (input.locationId !== undefined) {
        if (
          scopedLocationIds !== null &&
          !scopedLocationIds.includes(input.locationId)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Location does not belong to your effective access scope",
          });
        }

        const [match] = await db
          .select()
          .from(locations)
          .where(
            and(
              eq(locations.id, input.locationId),
              inArray(locations.business_id, businessIds),
              eq(locations.status, "active"),
            ),
          )
          .limit(1);

        if (!match) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Location does not belong to any of your businesses",
          });
        }

        return match;
      }

      const conditions = [
        inArray(locations.business_id, businessIds),
        eq(locations.status, "active"),
      ];
      if (scopedLocationIds !== null && scopedLocationIds.length > 0) {
        conditions.push(inArray(locations.id, scopedLocationIds));
      }

      const [first] = await db
        .select()
        .from(locations)
        .where(and(...conditions))
        .orderBy(locations.id)
        .limit(1);

      return first ?? null;
    }),
});
