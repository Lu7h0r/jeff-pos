import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { router } from "../init";
import { ownerOrManager } from "../role-guards";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import {
  user,
  businessMembers,
  locationMembers,
  locations,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const ROLES = ["owner", "manager", "cashier", "artist", "viewer"] as const;
const roleSchema = z.enum(ROLES);
const membershipTypeSchema = z.enum(["business", "location"]);

const memberRowSchema = z.object({
  type: membershipTypeSchema,
  membershipId: z.number(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  status: z.string(),
  locationId: z.number().nullable(),
  locationName: z.string().nullable(),
  createdAt: z.date().nullable(),
});

const inviteResultSchema = z.object({
  type: membershipTypeSchema,
  membershipId: z.number(),
  userId: z.string(),
  email: z.string(),
  role: roleSchema,
  locationId: z.number().nullable(),
  generatedPassword: z.string().nullable(),
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

/**
 * MVP password generator. Returns 14 characters of base64-ish entropy. The
 * inviting owner/manager is shown the result ONCE in the UI and is expected
 * to share it manually with the invitee. Future work: email-invite flow with
 * one-time tokens (see DEUDA after this batch).
 */
function generatePassword(): string {
  const bytes = new Uint8Array(11);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "A")
    .replace(/\//g, "z")
    .replace(/=+$/g, "")
    .slice(0, 14);
}

export const teamRouter = router({
  // Lists every active/suspended membership of the active business — both
  // broad (business_members) and granular (location_members), joined with
  // user info for the UI table.
  list: ownerOrManager
    .meta({
      openapi: {
        method: "GET",
        path: "/team",
        tags: ["Team"],
        summary: "List business + location members of the active business",
      },
    })
    .input(z.void())
    .output(z.array(memberRowSchema))
    .query(async ({ ctx }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      const broad = await db
        .select({
          membershipId: businessMembers.id,
          userId: businessMembers.user_id,
          role: businessMembers.role,
          status: businessMembers.status,
          createdAt: businessMembers.created_at,
          email: user.email,
          name: user.name,
        })
        .from(businessMembers)
        .innerJoin(user, eq(user.id, businessMembers.user_id))
        .where(eq(businessMembers.business_id, businessId));

      const granular = await db
        .select({
          membershipId: locationMembers.id,
          userId: locationMembers.user_id,
          role: locationMembers.role,
          status: locationMembers.status,
          createdAt: locationMembers.created_at,
          email: user.email,
          name: user.name,
          locationId: locationMembers.location_id,
          locationName: locations.name,
        })
        .from(locationMembers)
        .innerJoin(user, eq(user.id, locationMembers.user_id))
        .innerJoin(locations, eq(locations.id, locationMembers.location_id))
        .where(eq(locationMembers.business_id, businessId));

      const all = [
        ...broad
          .filter((row) => row.status !== "removed")
          .map((row) => ({
            type: "business" as const,
            membershipId: row.membershipId,
            userId: row.userId,
            email: row.email,
            name: row.name,
            role: row.role,
            status: row.status,
            locationId: null,
            locationName: null,
            createdAt: row.createdAt,
          })),
        ...granular
          .filter((row) => row.status !== "removed")
          .map((row) => ({
            type: "location" as const,
            membershipId: row.membershipId,
            userId: row.userId,
            email: row.email,
            name: row.name,
            role: row.role,
            status: row.status,
            locationId: row.locationId,
            locationName: row.locationName,
            createdAt: row.createdAt,
          })),
      ];

      return all.sort((a, b) =>
        (a.email ?? "").localeCompare(b.email ?? ""),
      );
    }),

  // Invite a new (or existing) user as a member of the active business.
  // Either business-wide (broad) or location-scoped (granular). When the
  // user does not yet exist a Better Auth account is created and a strong
  // 14-char random password is returned ONCE so the inviter can share it
  // manually. Future: replace with magic-link/email-invite flow.
  invite: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/team/invite",
        tags: ["Team"],
        summary: "Create or attach a user to the active business",
      },
    })
    .input(
      z.object({
        email: z.string().email(),
        displayName: z.string().min(1).max(255),
        password: z.string().min(8).max(128).optional(),
        role: roleSchema,
        scope: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("business") }),
          z.object({
            kind: z.literal("location"),
            locationId: z.number().int().positive(),
          }),
        ]),
      }),
    )
    .output(inviteResultSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      if (input.scope.kind === "location") {
        const [loc] = await db
          .select()
          .from(locations)
          .where(eq(locations.id, input.scope.locationId))
          .limit(1);
        if (!loc) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Location not found",
          });
        }
        if (loc.business_id !== businessId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Location belongs to a different business",
          });
        }
      }

      const normalizedEmail = input.email.trim().toLowerCase();
      const [existingUser] = await db
        .select()
        .from(user)
        .where(eq(user.email, normalizedEmail))
        .limit(1);

      let userId: string;
      let generatedPassword: string | null = null;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        const password = input.password ?? generatePassword();
        const signUpRes = await auth.api.signUpEmail({
          body: {
            name: input.displayName.trim(),
            email: normalizedEmail,
            password,
          },
        });
        userId = signUpRes.user.id;
        if (!input.password) generatedPassword = password;
        else generatedPassword = password;
      }

      // Architectural rule: a user has memberships at exactly ONE level for a
      // given business — broad business_members OR granular location_members,
      // never both. team.invite enforces this; resolveActiveContext breaks
      // the tie in favour of broad if both somehow coexist.
      const [conflictBroad] = await db
        .select({ id: businessMembers.id })
        .from(businessMembers)
        .where(
          and(
            eq(businessMembers.user_id, userId),
            eq(businessMembers.business_id, businessId),
            eq(businessMembers.status, "active"),
          ),
        )
        .limit(1);

      const [conflictLocation] = await db
        .select({ id: locationMembers.id })
        .from(locationMembers)
        .where(
          and(
            eq(locationMembers.user_id, userId),
            eq(locationMembers.business_id, businessId),
            eq(locationMembers.status, "active"),
          ),
        )
        .limit(1);

      if (input.scope.kind === "business" && conflictLocation) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "User already has location-scoped membership; remove it before promoting to business-wide",
        });
      }
      if (input.scope.kind === "location" && conflictBroad) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "User already has business-wide membership; remove it before scoping to a location",
        });
      }

      if (input.scope.kind === "business") {
        if (conflictBroad) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "User is already a member of this business",
          });
        }
        const [created] = await db
          .insert(businessMembers)
          .values({
            business_id: businessId,
            user_id: userId,
            role: input.role,
            status: "active",
          })
          .returning();
        return {
          type: "business" as const,
          membershipId: created.id,
          userId,
          email: normalizedEmail,
          role: roleSchema.parse(created.role),
          locationId: null,
          generatedPassword,
        };
      }

      const [created] = await db
        .insert(locationMembers)
        .values({
          business_id: businessId,
          location_id: input.scope.locationId,
          user_id: userId,
          role: input.role,
          status: "active",
        })
        .returning();
      return {
        type: "location" as const,
        membershipId: created.id,
        userId,
        email: normalizedEmail,
        role: roleSchema.parse(created.role),
        locationId: created.location_id,
        generatedPassword,
      };
    }),

  updateRole: ownerOrManager
    .meta({
      openapi: {
        method: "PATCH",
        path: "/team/{type}/{membershipId}/role",
        tags: ["Team"],
        summary: "Change the role of a business or location membership",
      },
    })
    .input(
      z.object({
        membershipId: z.number().int().positive(),
        type: membershipTypeSchema,
        role: roleSchema,
      }),
    )
    .output(
      z.object({
        type: membershipTypeSchema,
        membershipId: z.number(),
        role: roleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      if (input.type === "business") {
        const [row] = await db
          .select()
          .from(businessMembers)
          .where(eq(businessMembers.id, input.membershipId))
          .limit(1);
        if (!row || row.business_id !== businessId) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Membership not found",
          });
        }
        const [updated] = await db
          .update(businessMembers)
          .set({ role: input.role })
          .where(eq(businessMembers.id, row.id))
          .returning();
        return {
          type: "business" as const,
          membershipId: updated.id,
          role: roleSchema.parse(updated.role),
        };
      }

      const [row] = await db
        .select()
        .from(locationMembers)
        .where(eq(locationMembers.id, input.membershipId))
        .limit(1);
      if (!row || row.business_id !== businessId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Membership not found",
        });
      }
      const [updated] = await db
        .update(locationMembers)
        .set({ role: input.role })
        .where(eq(locationMembers.id, row.id))
        .returning();
      return {
        type: "location" as const,
        membershipId: updated.id,
        role: roleSchema.parse(updated.role),
      };
    }),

  // Soft-removes the membership (status="removed"). Better Auth user account
  // stays alive — the same person may belong to other businesses.
  archive: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/team/{type}/{membershipId}/archive",
        tags: ["Team"],
        summary: "Soft-remove a membership (status=removed)",
      },
    })
    .input(
      z.object({
        membershipId: z.number().int().positive(),
        type: membershipTypeSchema,
      }),
    )
    .output(
      z.object({
        type: membershipTypeSchema,
        membershipId: z.number(),
        status: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      if (input.type === "business") {
        const [row] = await db
          .select()
          .from(businessMembers)
          .where(eq(businessMembers.id, input.membershipId))
          .limit(1);
        if (!row || row.business_id !== businessId) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Membership not found",
          });
        }
        const [updated] = await db
          .update(businessMembers)
          .set({ status: "removed" })
          .where(eq(businessMembers.id, row.id))
          .returning();
        return {
          type: "business" as const,
          membershipId: updated.id,
          status: updated.status,
        };
      }

      const [row] = await db
        .select()
        .from(locationMembers)
        .where(eq(locationMembers.id, input.membershipId))
        .limit(1);
      if (!row || row.business_id !== businessId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Membership not found",
        });
      }
      const [updated] = await db
        .update(locationMembers)
        .set({ status: "removed" })
        .where(eq(locationMembers.id, row.id))
        .returning();
      return {
        type: "location" as const,
        membershipId: updated.id,
        status: updated.status,
      };
    }),
});
