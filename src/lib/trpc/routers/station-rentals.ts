import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { ownerOrManager } from "../role-guards";
import { db } from "@/lib/db";
import {
  stationRentals,
  workstations,
  staffMembers,
  cashSessions,
  cashMovements,
  paymentMethods,
} from "@/lib/db/schema";
import { eq, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { assertLocationAllowed } from "../scope-guards";

const rentalStatusSchema = z.enum(["scheduled", "completed", "cancelled"]);

const rentalSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  workstation_id: z.number(),
  staff_member_id: z.number(),
  cash_session_id: z.number().nullable(),
  payment_method_id: z.number().nullable(),
  amount: z.number(),
  start_at: z.date(),
  end_at: z.date(),
  status: rentalStatusSchema,
  notes: z.string().nullable(),
  created_by_user_id: z.string(),
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

function rowToOutput(row: typeof stationRentals.$inferSelect) {
  return { ...row, status: rentalStatusSchema.parse(row.status) };
}

async function loadOwned(rentalId: number, businessId: number) {
  const [row] = await db
    .select()
    .from(stationRentals)
    .where(eq(stationRentals.id, rentalId))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Station rental not found",
    });
  }
  if (row.business_id !== businessId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Station rental belongs to a different business",
    });
  }
  return row;
}

export const stationRentalsRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/station-rentals",
        tags: ["StationRentals"],
        summary: "List station rentals with optional filters",
      },
    })
    .input(
      z.object({
        locationId: z.number().int().positive().optional(),
        rangeFrom: z.date().optional(),
        rangeTo: z.date().optional(),
        status: rentalStatusSchema.optional(),
      }),
    )
    .output(z.array(rentalSchema))
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const conditions = [eq(stationRentals.business_id, businessId)];
      if (input.locationId !== undefined) {
        assertLocationAllowed(ctx, input.locationId);
        conditions.push(eq(stationRentals.location_id, input.locationId));
      } else if (
        ctx.isLocationScoped &&
        ctx.effectiveLocationIds.length > 0
      ) {
        conditions.push(
          inArray(stationRentals.location_id, ctx.effectiveLocationIds),
        );
      }
      if (input.rangeFrom !== undefined)
        conditions.push(gte(stationRentals.start_at, input.rangeFrom));
      if (input.rangeTo !== undefined)
        conditions.push(lte(stationRentals.start_at, input.rangeTo));
      if (input.status !== undefined)
        conditions.push(eq(stationRentals.status, input.status));

      const rows = await db
        .select()
        .from(stationRentals)
        .where(and(...conditions))
        .orderBy(stationRentals.start_at);
      return rows.map(rowToOutput);
    }),

  create: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/station-rentals",
        tags: ["StationRentals"],
        summary: "Schedule a station rental (with overlap detection)",
      },
    })
    .input(
      z.object({
        workstationId: z.number().int().positive(),
        staffMemberId: z.number().int().positive(),
        startAt: z.date(),
        endAt: z.date(),
        amount: z.number().int().positive(),
        paymentMethodId: z.number().int().positive().optional(),
        cashSessionId: z.number().int().positive().optional(),
        notes: z.string().optional(),
      }),
    )
    .output(rentalSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      if (input.endAt <= input.startAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "end_at must be after start_at",
        });
      }

      const [ws] = await db
        .select()
        .from(workstations)
        .where(eq(workstations.id, input.workstationId))
        .limit(1);
      if (!ws) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workstation not found",
        });
      }
      if (ws.business_id !== businessId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Workstation belongs to a different business",
        });
      }
      assertLocationAllowed(ctx, ws.location_id);

      const [staff] = await db
        .select()
        .from(staffMembers)
        .where(eq(staffMembers.id, input.staffMemberId))
        .limit(1);
      if (!staff) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Staff member not found",
        });
      }
      if (staff.business_id !== businessId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff member belongs to a different business",
        });
      }

      // Overlap check: any non-cancelled rental on the same workstation whose
      // [start_at, end_at) intersects [input.startAt, input.endAt) is a
      // conflict. Using exclusive end so back-to-back bookings are allowed.
      const overlapping = await db
        .select({ id: stationRentals.id })
        .from(stationRentals)
        .where(
          and(
            eq(stationRentals.workstation_id, input.workstationId),
            sql`${stationRentals.status} <> 'cancelled'`,
            sql`${stationRentals.start_at} < ${input.endAt}`,
            sql`${stationRentals.end_at} > ${input.startAt}`,
          ),
        )
        .limit(1);
      if (overlapping.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Workstation is already booked for this time range",
        });
      }

      let session: typeof cashSessions.$inferSelect | null = null;
      if (input.cashSessionId !== undefined) {
        const [found] = await db
          .select()
          .from(cashSessions)
          .where(eq(cashSessions.id, input.cashSessionId))
          .limit(1);
        if (!found) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Cash session not found",
          });
        }
        if (found.business_id !== businessId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cash session belongs to a different business",
          });
        }
        if (found.status !== "open") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Cash session is closed",
          });
        }
        session = found;
      }

      let paymentMethod: typeof paymentMethods.$inferSelect | null = null;
      if (input.paymentMethodId !== undefined) {
        const [pm] = await db
          .select()
          .from(paymentMethods)
          .where(eq(paymentMethods.id, input.paymentMethodId))
          .limit(1);
        if (!pm) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Payment method not found",
          });
        }
        if (pm.business_id != null && pm.business_id !== businessId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Payment method belongs to a different business",
          });
        }
        paymentMethod = pm;
      }

      // Cash classification heuristic (DA-9): same as orders.create /
      // expenses / purchases. Station rentals are INCOME — positive cash.
      const isCashMethod =
        !!paymentMethod && paymentMethod.name.toLowerCase().includes("cash");

      return await db.transaction(async (tx) => {
        const [rental] = await tx
          .insert(stationRentals)
          .values({
            business_id: businessId,
            location_id: ws.location_id,
            workstation_id: ws.id,
            staff_member_id: staff.id,
            cash_session_id: input.cashSessionId ?? null,
            payment_method_id: input.paymentMethodId ?? null,
            amount: input.amount,
            start_at: input.startAt,
            end_at: input.endAt,
            status: "scheduled",
            notes: input.notes ?? null,
            created_by_user_id: ctx.user.id,
          })
          .returning();

        if (session && isCashMethod) {
          const [latest] = await tx
            .select({ balance_after: cashMovements.balance_after })
            .from(cashMovements)
            .where(eq(cashMovements.cash_session_id, session.id))
            .orderBy(desc(cashMovements.id))
            .limit(1);
          const balanceBefore =
            latest?.balance_after ?? session.opening_cash_amount;
          const balanceAfter = balanceBefore + input.amount;

          await tx.insert(cashMovements).values({
            business_id: businessId,
            location_id: session.location_id,
            cash_session_id: session.id,
            type: "manual_in",
            payment_method_id: input.paymentMethodId ?? null,
            source_type: "station_rental",
            source_id: rental.id,
            amount: input.amount,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
            transaction_type: "positive",
            created_by_user_id: ctx.user.id,
            notes: input.notes ?? null,
          });

          await tx
            .update(cashSessions)
            .set({
              expected_cash_amount:
                session.expected_cash_amount + input.amount,
            })
            .where(eq(cashSessions.id, session.id));
        }

        return rowToOutput(rental);
      });
    }),

  markCompleted: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/station-rentals/{id}/complete",
        tags: ["StationRentals"],
        summary: "Mark a scheduled rental as completed",
      },
    })
    .input(z.object({ id: z.number().int().positive() }))
    .output(rentalSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const rental = await loadOwned(input.id, businessId);
      assertLocationAllowed(ctx, rental.location_id);
      if (rental.status !== "scheduled") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot complete a rental in status ${rental.status}`,
        });
      }
      const [updated] = await db
        .update(stationRentals)
        .set({ status: "completed" })
        .where(eq(stationRentals.id, rental.id))
        .returning();
      return rowToOutput(updated);
    }),

  cancel: ownerOrManager
    .meta({
      openapi: {
        method: "POST",
        path: "/station-rentals/{id}/cancel",
        tags: ["StationRentals"],
        summary: "Cancel a rental (reverses cash movement when applicable)",
      },
    })
    .input(
      z.object({
        id: z.number().int().positive(),
        reason: z.string().optional(),
      }),
    )
    .output(rentalSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const rental = await loadOwned(input.id, businessId);
      assertLocationAllowed(ctx, rental.location_id);
      if (rental.status === "cancelled") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Rental is already cancelled",
        });
      }

      // Detect a previously-written cash_movement (income side); reversal
      // looked up by source_type/source_id rather than re-running the cash
      // heuristic so renaming a payment method later cannot desync.
      const [originalMovement] = rental.cash_session_id
        ? await db
            .select()
            .from(cashMovements)
            .where(
              and(
                eq(cashMovements.source_type, "station_rental"),
                eq(cashMovements.source_id, rental.id),
                eq(cashMovements.cash_session_id, rental.cash_session_id),
              ),
            )
            .limit(1)
        : [];

      // DA-13: refuse to mutate the cash drawer once the relevant session
      // is closed. Caller is expected to reopen or post a manual movement.
      if (originalMovement) {
        const [session] = await db
          .select()
          .from(cashSessions)
          .where(eq(cashSessions.id, originalMovement.cash_session_id))
          .limit(1);
        if (!session || session.status !== "open") {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Cannot cancel: the cash session for this rental is closed.",
          });
        }
      }

      return await db.transaction(async (tx) => {
        if (originalMovement) {
          const [session] = await tx
            .select()
            .from(cashSessions)
            .where(eq(cashSessions.id, originalMovement.cash_session_id))
            .limit(1);

          if (session && session.status === "open") {
            const [latest] = await tx
              .select({ balance_after: cashMovements.balance_after })
              .from(cashMovements)
              .where(eq(cashMovements.cash_session_id, session.id))
              .orderBy(desc(cashMovements.id))
              .limit(1);
            const balanceBefore =
              latest?.balance_after ?? session.opening_cash_amount;
            // originalMovement.amount is positive (manual_in income).
            // Reversal removes the same money from the drawer.
            const reversalAmount = -originalMovement.amount;
            const balanceAfter = balanceBefore + reversalAmount;

            await tx.insert(cashMovements).values({
              business_id: rental.business_id,
              location_id: session.location_id,
              cash_session_id: session.id,
              type: "manual_out",
              payment_method_id: originalMovement.payment_method_id,
              source_type: "station_rental_cancel",
              source_id: rental.id,
              amount: reversalAmount,
              balance_before: balanceBefore,
              balance_after: balanceAfter,
              transaction_type: "negative",
              created_by_user_id: ctx.user.id,
              notes: input.reason ?? null,
            });

            await tx
              .update(cashSessions)
              .set({
                expected_cash_amount:
                  session.expected_cash_amount + reversalAmount,
              })
              .where(eq(cashSessions.id, session.id));
          }
        }

        const [updated] = await tx
          .update(stationRentals)
          .set({
            status: "cancelled",
            notes: input.reason
              ? rental.notes
                ? `${rental.notes}\n${input.reason}`
                : input.reason
              : rental.notes,
          })
          .where(eq(stationRentals.id, rental.id))
          .returning();
        return rowToOutput(updated);
      });
    }),
});
