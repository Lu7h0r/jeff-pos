import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { locations, businessMembers } from "@/lib/db/schema";
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
 * Returns the business_ids the user has active membership in.
 * Single source of truth for cross-business isolation in this router.
 */
async function userBusinessIds(userId: string): Promise<number[]> {
  const rows = await db
    .select({ business_id: businessMembers.business_id })
    .from(businessMembers)
    .where(
      and(
        eq(businessMembers.user_id, userId),
        eq(businessMembers.status, "active"),
      ),
    );

  return rows.map((row) => row.business_id);
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
      const businessIds = await userBusinessIds(ctx.user.id);
      if (businessIds.length === 0) return [];

      return db
        .select()
        .from(locations)
        .where(
          and(
            inArray(locations.business_id, businessIds),
            eq(locations.status, "active"),
          ),
        )
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
      const businessIds = await userBusinessIds(ctx.user.id);
      if (businessIds.length === 0) return null;

      if (input.locationId !== undefined) {
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

      const [first] = await db
        .select()
        .from(locations)
        .where(
          and(
            inArray(locations.business_id, businessIds),
            eq(locations.status, "active"),
          ),
        )
        .orderBy(locations.id)
        .limit(1);

      return first ?? null;
    }),
});
