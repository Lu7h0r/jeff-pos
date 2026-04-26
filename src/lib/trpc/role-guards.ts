import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "./init";

export const ALLOWED_ROLES = [
  "owner",
  "manager",
  "cashier",
  "artist",
  "viewer",
] as const;

export type Role = (typeof ALLOWED_ROLES)[number];

/**
 * Builds a `protectedProcedure` extension that rejects with FORBIDDEN unless
 * `ctx.activeRole` matches one of the `allowed` roles. Backend gate — the
 * UI may also hide nav items by role, but this is the security boundary.
 */
export function requireRole(allowed: readonly Role[]) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    if (!ctx.activeRole) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No active role resolved",
      });
    }
    if (!(allowed as readonly string[]).includes(ctx.activeRole)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Role '${ctx.activeRole}' not permitted; required: ${allowed.join(" | ")}`,
      });
    }
    return next();
  });
}

export const ownerOnly = requireRole(["owner"]);
export const ownerOrManager = requireRole(["owner", "manager"]);
export const operationalRole = requireRole(["owner", "manager", "cashier"]);
export const artistOrAbove = requireRole(["owner", "manager", "artist"]);
