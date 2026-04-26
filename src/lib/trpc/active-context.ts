import { db } from "@/lib/db";
import { businessMembers, locations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export interface ActiveContext {
  businessId: number;
  locationId: number | null;
  role: string;
}

/**
 * Resolves the active business and location for a given user.
 *
 * Strategy:
 * 1. Pick the oldest active membership (deterministic; multi-business
 *    switching UI is deferred — see PLAN.md Capa 0).
 * 2. If a locationIdHint is provided and belongs to that business and is
 *    active, use it. Otherwise fall back to the first active location.
 *
 * Returns null if the user has no active membership in any business.
 *
 * This function does not throw on missing data — callers are expected to
 * treat null as "no active business" and either degrade gracefully (legacy
 * routers like customers.list with user_uid fallback) or return an error
 * (operational routers like cashSessions.open that require a business).
 */
export async function resolveActiveContext(
  userId: string,
  locationIdHint?: number | null,
): Promise<ActiveContext | null> {
  const memberships = await db
    .select({
      business_id: businessMembers.business_id,
      role: businessMembers.role,
    })
    .from(businessMembers)
    .where(
      and(
        eq(businessMembers.user_id, userId),
        eq(businessMembers.status, "active"),
      ),
    )
    .orderBy(businessMembers.created_at)
    .limit(1);

  if (memberships.length === 0) return null;

  const { business_id, role } = memberships[0];

  if (locationIdHint != null) {
    const [match] = await db
      .select()
      .from(locations)
      .where(
        and(
          eq(locations.id, locationIdHint),
          eq(locations.business_id, business_id),
          eq(locations.status, "active"),
        ),
      )
      .limit(1);

    if (match) {
      return { businessId: business_id, locationId: match.id, role };
    }
  }

  const [first] = await db
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.business_id, business_id),
        eq(locations.status, "active"),
      ),
    )
    .orderBy(locations.id)
    .limit(1);

  return {
    businessId: business_id,
    locationId: first?.id ?? null,
    role,
  };
}
