import { TRPCError } from "@trpc/server";
import type { TRPCContext } from "./init";

/**
 * Backend gate for granular (location-scoped) users (closes DA-25).
 *
 * Broad members (`isLocationScoped === false`) bypass this check — their
 * cross-business isolation is handled by membership/business_id assertions
 * in each router. Granular members can only operate on locations listed in
 * `ctx.effectiveLocationIds`; any other locationId — even one belonging to
 * the same business — must be rejected with FORBIDDEN.
 *
 * Used by every router that accepts `locationId` (or `fromLocationId` /
 * `toLocationId` for transfers) as input, and by routers that operate on a
 * row with an implicit `location_id` (orders, purchases, workstations,
 * cash sessions, station rentals, …) by passing the row's column.
 */
export function assertLocationAllowed(
  ctx: TRPCContext,
  locationId: number,
): void {
  if (!ctx.isLocationScoped) return;
  if (!ctx.effectiveLocationIds.includes(locationId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You don't have access to this location",
    });
  }
}
