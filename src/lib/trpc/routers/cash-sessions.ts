import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { cashSessions, locations, businessMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const sessionStatusSchema = z.enum(["open", "closed"]);

const cashSessionSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  opened_by_user_id: z.string(),
  closed_by_user_id: z.string().nullable(),
  opening_cash_amount: z.number(),
  expected_cash_amount: z.number(),
  counted_cash_amount: z.number().nullable(),
  expected_digital_amount: z.number(),
  difference_amount: z.number().nullable(),
  status: sessionStatusSchema,
  opened_at: z.date().nullable(),
  closed_at: z.date().nullable(),
  notes: z.string().nullable(),
});

/**
 * Resolve the location and validate that the user has active membership
 * in the location's business. Returns the location row on success, throws
 * TRPCError otherwise. Single source of truth for cross-business isolation.
 */
async function assertLocationAccess(userId: string, locationId: number) {
  const [loc] = await db
    .select()
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1);

  if (!loc) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
  }

  const [membership] = await db
    .select({ id: businessMembers.id })
    .from(businessMembers)
    .where(
      and(
        eq(businessMembers.user_id, userId),
        eq(businessMembers.business_id, loc.business_id),
        eq(businessMembers.status, "active"),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of this business",
    });
  }

  return loc;
}

export const cashSessionsRouter = router({
  open: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/cash-sessions/open",
        tags: ["CashSessions"],
        summary: "Open a cash session for a location",
      },
    })
    .input(
      z.object({
        locationId: z.number().int().positive(),
        openingCashAmount: z.number().int().nonnegative(),
        notes: z.string().optional(),
      }),
    )
    .output(cashSessionSchema)
    .mutation(async ({ ctx, input }) => {
      const loc = await assertLocationAccess(ctx.user.id, input.locationId);

      const [existingOpen] = await db
        .select({ id: cashSessions.id })
        .from(cashSessions)
        .where(
          and(
            eq(cashSessions.location_id, loc.id),
            eq(cashSessions.status, "open"),
          ),
        )
        .limit(1);

      if (existingOpen) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "There is already an open cash session for this location",
        });
      }

      const [created] = await db
        .insert(cashSessions)
        .values({
          business_id: loc.business_id,
          location_id: loc.id,
          opened_by_user_id: ctx.user.id,
          opening_cash_amount: input.openingCashAmount,
          expected_cash_amount: input.openingCashAmount,
          expected_digital_amount: 0,
          status: "open",
          notes: input.notes ?? null,
        })
        .returning();

      return {
        ...created,
        status: sessionStatusSchema.parse(created.status),
      };
    }),

  current: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/cash-sessions/current",
        tags: ["CashSessions"],
        summary: "Get the open cash session for a location, if any",
      },
    })
    .input(z.object({ locationId: z.number().int().positive() }))
    .output(cashSessionSchema.nullable())
    .query(async ({ ctx, input }) => {
      const loc = await assertLocationAccess(ctx.user.id, input.locationId);

      const [open] = await db
        .select()
        .from(cashSessions)
        .where(
          and(
            eq(cashSessions.location_id, loc.id),
            eq(cashSessions.status, "open"),
          ),
        )
        .limit(1);

      if (!open) return null;

      return {
        ...open,
        status: sessionStatusSchema.parse(open.status),
      };
    }),

  close: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/cash-sessions/close",
        tags: ["CashSessions"],
        summary: "Close an open cash session with a counted cash amount",
      },
    })
    .input(
      z.object({
        cashSessionId: z.number().int().positive(),
        countedCashAmount: z.number().int().nonnegative(),
        notes: z.string().optional(),
      }),
    )
    .output(cashSessionSchema)
    .mutation(async ({ ctx, input }) => {
      const [session] = await db
        .select()
        .from(cashSessions)
        .where(eq(cashSessions.id, input.cashSessionId))
        .limit(1);

      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Cash session not found",
        });
      }

      const [membership] = await db
        .select({ id: businessMembers.id })
        .from(businessMembers)
        .where(
          and(
            eq(businessMembers.user_id, ctx.user.id),
            eq(businessMembers.business_id, session.business_id),
            eq(businessMembers.status, "active"),
          ),
        )
        .limit(1);

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a member of this business",
        });
      }

      if (session.status !== "open") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Cash session is already closed",
        });
      }

      const difference = input.countedCashAmount - session.expected_cash_amount;
      const mergedNotes = input.notes
        ? session.notes
          ? `${session.notes}\n${input.notes}`
          : input.notes
        : session.notes;

      const [updated] = await db
        .update(cashSessions)
        .set({
          status: "closed",
          closed_by_user_id: ctx.user.id,
          counted_cash_amount: input.countedCashAmount,
          difference_amount: difference,
          closed_at: new Date(),
          notes: mergedNotes,
        })
        .where(eq(cashSessions.id, session.id))
        .returning();

      return {
        ...updated,
        status: sessionStatusSchema.parse(updated.status),
      };
    }),
});
