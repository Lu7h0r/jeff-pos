import { db } from "@/lib/db";
import { businessMembers, locationMembers, locations } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";

export interface ActiveContext {
  businessId: number;
  locationId: number | null;
  role: string;
  isLocationScoped: boolean;
  effectiveLocationIds: number[];
}

/**
 * Resolves the active business and location for a given user.
 *
 * Two-tier resolution (closes DA-15):
 *
 * 1. BROAD access via `business_members` — the user has rights across every
 *    location of the business (owner / manager / cashier / artist).
 * 2. GRANULAR access via `location_members` — the user only operates at the
 *    listed sedes.
 *
 * Architectural rule: a user is member at exactly ONE level. If the database
 * happens to hold both kinds of rows for the same user, BROAD wins (defensive
 * choice; the team router prevents creating both via team.invite). The data
 * is still returned, but `isLocationScoped` will be false and effective
 * locations come from the business.
 *
 * Multi-business switching is deferred — for `business_members` we still pick
 * the oldest active membership deterministically. For `location_members` we
 * derive the businessId from the first row's location and assert that every
 * row shares that business; mixed-business location memberships are a data
 * integrity error and surface as a thrown error here (route layer maps it to
 * FORBIDDEN with a clear message).
 *
 * Returns null when the user has neither kind of membership — callers either
 * degrade gracefully (legacy routers) or return FORBIDDEN.
 */
export async function resolveActiveContext(
  userId: string,
  locationIdHint?: number | null,
): Promise<ActiveContext | null> {
  const [broad] = await db
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

  if (broad) {
    const activeLocations = await db
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(
          eq(locations.business_id, broad.business_id),
          eq(locations.status, "active"),
        ),
      )
      .orderBy(locations.id);

    const effectiveLocationIds = activeLocations.map((l) => l.id);
    const locationId = pickLocationId(effectiveLocationIds, locationIdHint);

    return {
      businessId: broad.business_id,
      locationId,
      role: broad.role,
      isLocationScoped: false,
      effectiveLocationIds,
    };
  }

  const granular = await db
    .select({
      business_id: locationMembers.business_id,
      location_id: locationMembers.location_id,
      role: locationMembers.role,
    })
    .from(locationMembers)
    .where(
      and(
        eq(locationMembers.user_id, userId),
        eq(locationMembers.status, "active"),
      ),
    )
    .orderBy(locationMembers.created_at);

  if (granular.length === 0) return null;

  const businessId = granular[0].business_id;
  const mismatched = granular.some((row) => row.business_id !== businessId);
  if (mismatched) {
    throw new Error(
      `location_members for user ${userId} span multiple businesses; ` +
        `data integrity violation`,
    );
  }

  const effectiveLocationIds = granular.map((row) => row.location_id);

  // Confirm the locations are still active. Removed/archived locations
  // shouldn't grant access even if the membership row stays around.
  const activeLocs = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.business_id, businessId),
        inArray(locations.id, effectiveLocationIds),
        eq(locations.status, "active"),
      ),
    );
  const activeIdSet = new Set(activeLocs.map((l) => l.id));
  const filteredLocationIds = effectiveLocationIds.filter((id) =>
    activeIdSet.has(id),
  );

  if (filteredLocationIds.length === 0) return null;

  const locationId = pickLocationId(filteredLocationIds, locationIdHint);
  const matched =
    locationIdHint != null && filteredLocationIds.includes(locationIdHint)
      ? granular.find((row) => row.location_id === locationIdHint)
      : granular.find((row) => row.location_id === filteredLocationIds[0]);

  return {
    businessId,
    locationId,
    role: matched?.role ?? granular[0].role,
    isLocationScoped: true,
    effectiveLocationIds: filteredLocationIds,
  };
}

function pickLocationId(
  effective: number[],
  hint: number | null | undefined,
): number | null {
  if (effective.length === 0) return null;
  if (hint != null && effective.includes(hint)) return hint;
  return effective[0];
}
