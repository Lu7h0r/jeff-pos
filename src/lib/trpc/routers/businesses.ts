import { z } from "zod/v4";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { businesses, businessMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const businessSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  created_at: z.date().nullable(),
});

const memberRoleSchema = z.enum(["owner", "manager", "cashier", "artist"]);

const currentBusinessSchema = businessSchema.extend({
  role: memberRoleSchema,
});

/**
 * Returns the first active business the current user belongs to.
 *
 * MVP rule: a user can be member of multiple businesses but only one is
 * "current" at a time. Until multi-business switching UI exists (deferred),
 * we pick the oldest active membership deterministically.
 */
export const businessesRouter = router({
  getCurrent: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/businesses/current",
        tags: ["Businesses"],
        summary: "Get the current business for the authenticated user",
      },
    })
    .input(z.void())
    .output(currentBusinessSchema.nullable())
    .query(async ({ ctx }) => {
      const rows = await db
        .select({
          id: businesses.id,
          name: businesses.name,
          slug: businesses.slug,
          created_at: businesses.created_at,
          role: businessMembers.role,
        })
        .from(businesses)
        .innerJoin(
          businessMembers,
          eq(businessMembers.business_id, businesses.id),
        )
        .where(
          and(
            eq(businessMembers.user_id, ctx.user.id),
            eq(businessMembers.status, "active"),
          ),
        )
        .orderBy(businessMembers.created_at)
        .limit(1);

      if (rows.length === 0) return null;

      const [row] = rows;
      const parsed = memberRoleSchema.safeParse(row.role);
      if (!parsed.success) return null;

      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        created_at: row.created_at,
        role: parsed.data,
      };
    }),
});
