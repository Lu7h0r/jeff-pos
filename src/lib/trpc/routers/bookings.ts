import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, gt, inArray, lt, lte, ne, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import {
  bookings,
  bookingEvents,
  businessMembers,
  customers,
  followUpOutboxEvents,
  locations,
  serviceAgreements,
  staffMembers,
} from "@/lib/db/schema";
import { assertLocationAllowed } from "../scope-guards";
import { operationalRole } from "../role-guards";
import { protectedProcedure, router } from "../init";

const bookingServiceKindSchema = z.enum(["tattoo", "piercing", "other"]);
const bookingStatusSchema = z.enum([
  "pending",
  "confirmed",
  "checked_in",
  "completed",
  "cancelled",
  "no_show",
]);
const bookingConfirmationStatusSchema = z.enum([
  "pending",
  "confirmed",
  "unconfirmed",
]);
const bookingEventTypeSchema = z.enum([
  "create",
  "confirm",
  "reschedule",
  "cancel",
  "check_in",
  "no_show",
  "completed",
  "convert_to_service",
]);
const outboxBookingEventTypeSchema = z.enum([
  "booking_created",
  "booking_confirmed",
  "booking_rescheduled",
  "booking_cancelled",
]);

const bookingSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  customer_id: z.number().nullable(),
  staff_id: z.number().nullable(),
  service_kind: bookingServiceKindSchema,
  title: z.string(),
  notes: z.string().nullable(),
  starts_at: z.date(),
  ends_at: z.date(),
  status: bookingStatusSchema,
  confirmation_status: bookingConfirmationStatusSchema,
  service_agreement_id: z.number().nullable(),
  created_at: z.date().nullable(),
});

const bookingEventSchema = z.object({
  id: z.number(),
  booking_id: z.number(),
  business_id: z.number(),
  event_type: bookingEventTypeSchema,
  payload_json: z.string(),
  actor_user_id: z.string().nullable(),
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

function mapBooking(row: typeof bookings.$inferSelect) {
  return {
    ...row,
    service_kind: bookingServiceKindSchema.parse(row.service_kind),
    status: bookingStatusSchema.parse(row.status),
    confirmation_status: bookingConfirmationStatusSchema.parse(
      row.confirmation_status,
    ),
  };
}

async function assertMembership(userId: string, businessId: number) {
  const [m] = await db
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

  if (!m) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of this business",
    });
  }
}

async function loadBookingOwned(bookingId: number, businessId: number) {
  const [existing] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });
  }

  if (existing.business_id !== businessId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Booking belongs to a different business",
    });
  }

  return existing;
}

async function recordBookingEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    bookingId: number;
    businessId: number;
    eventType: z.infer<typeof bookingEventTypeSchema>;
    payload: Record<string, unknown>;
    actorUserId: string | null;
  },
) {
  await tx.insert(bookingEvents).values({
    booking_id: input.bookingId,
    business_id: input.businessId,
    event_type: input.eventType,
    payload_json: JSON.stringify(input.payload),
    actor_user_id: input.actorUserId,
  });
}

async function enqueueBookingOutboxEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    booking: typeof bookings.$inferSelect;
    eventType: z.infer<typeof outboxBookingEventTypeSchema>;
    actorUserId: string;
    payload: Record<string, unknown>;
  },
) {
  const idempotencyKey = `${input.eventType}:booking:${input.booking.id}`;
  await tx
    .insert(followUpOutboxEvents)
    .values({
      business_id: input.booking.business_id,
      location_id: input.booking.location_id,
      customer_id: input.booking.customer_id,
      booking_id: input.booking.id,
      event_type: input.eventType,
      idempotency_key: idempotencyKey,
      payload_json: JSON.stringify({ ...input.payload, idempotencyKey }),
      status: "pending",
      attempts: 0,
      created_by_user_id: input.actorUserId,
    });
}

async function assertBookingNoOverlap(
  input: {
    businessId: number;
    locationId: number;
    staffId: number;
    startsAt: Date;
    endsAt: Date;
    excludeBookingId?: number;
  },
) {
  const conditions: SQL[] = [
    eq(bookings.business_id, input.businessId),
    eq(bookings.location_id, input.locationId),
    eq(bookings.staff_id, input.staffId),
    ne(bookings.status, "cancelled"),
    lt(bookings.starts_at, input.endsAt),
    gt(bookings.ends_at, input.startsAt),
  ];

  if (input.excludeBookingId !== undefined) {
    conditions.push(ne(bookings.id, input.excludeBookingId));
  }

  const [conflict] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(...conditions))
    .limit(1);

  if (conflict) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Staff member already has a booking in this time range",
    });
  }
}

export const bookingsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        startsAt: z.date(),
        endsAt: z.date(),
        locationId: z.number().int().positive().optional(),
        staffId: z.number().int().positive().optional(),
      }),
    )
    .output(z.array(bookingSchema))
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      if (input.locationId !== undefined) {
        assertLocationAllowed(ctx, input.locationId);
      }

      const where = and(
        eq(bookings.business_id, businessId),
        gte(bookings.starts_at, input.startsAt),
        lte(bookings.starts_at, input.endsAt),
        input.locationId !== undefined
          ? eq(bookings.location_id, input.locationId)
          : ctx.isLocationScoped && ctx.effectiveLocationIds.length > 0
            ? inArray(bookings.location_id, ctx.effectiveLocationIds)
            : undefined,
        input.staffId !== undefined ? eq(bookings.staff_id, input.staffId) : undefined,
      );

      const rows = await db
        .select()
        .from(bookings)
        .where(where)
        .orderBy(desc(bookings.starts_at));

      return rows.map(mapBooking);
    }),

  listEvents: protectedProcedure
    .input(z.object({ bookingId: z.number().int().positive() }))
    .output(z.array(bookingEventSchema))
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const booking = await loadBookingOwned(input.bookingId, businessId);
      assertLocationAllowed(ctx, booking.location_id);

      const rows = await db
        .select()
        .from(bookingEvents)
        .where(
          and(
            eq(bookingEvents.booking_id, input.bookingId),
            eq(bookingEvents.business_id, businessId),
          ),
        )
        .orderBy(desc(bookingEvents.created_at), desc(bookingEvents.id));

      return rows.map((row) => ({
        ...row,
        event_type: bookingEventTypeSchema.parse(row.event_type),
      }));
    }),

  create: operationalRole
    .input(
      z
        .object({
          locationId: z.number().int().positive(),
          customerId: z.number().int().positive().optional(),
          staffId: z.number().int().positive(),
          serviceKind: bookingServiceKindSchema,
          title: z.string().trim().min(1).max(255),
          notes: z.string().optional(),
          startsAt: z.date(),
          endsAt: z.date(),
        })
        .refine((value) => value.endsAt > value.startsAt, {
          message: "End date must be after start date",
          path: ["endsAt"],
        }),
    )
    .output(bookingSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      assertLocationAllowed(ctx, input.locationId);

      const [location] = await db
        .select()
        .from(locations)
        .where(eq(locations.id, input.locationId))
        .limit(1);
      if (!location || location.business_id !== businessId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Invalid location" });
      }

      if (input.customerId !== undefined) {
        const [customer] = await db
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.id, input.customerId),
              eq(customers.business_id, businessId),
            ),
          )
          .limit(1);
        if (!customer) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Customer belongs to a different business",
          });
        }
      }

      const [staff] = await db
        .select({ id: staffMembers.id })
        .from(staffMembers)
        .where(
          and(
            eq(staffMembers.id, input.staffId),
            eq(staffMembers.business_id, businessId),
            eq(staffMembers.archived, false),
          ),
        )
        .limit(1);
      if (!staff) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff member belongs to a different business",
        });
      }

      await assertBookingNoOverlap({
        businessId,
        locationId: input.locationId,
        staffId: input.staffId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      });

      const created = await db.transaction(async (tx) => {
        const [newBooking] = await tx
          .insert(bookings)
          .values({
            business_id: businessId,
            location_id: input.locationId,
            customer_id: input.customerId ?? null,
            staff_id: input.staffId,
            service_kind: input.serviceKind,
            title: input.title,
            notes: input.notes ?? null,
            starts_at: input.startsAt,
            ends_at: input.endsAt,
          status: "pending",
          confirmation_status: "pending",
        })
        .returning();

        await recordBookingEvent(tx, {
          bookingId: newBooking.id,
          businessId,
          eventType: "create",
          payload: {
            status: newBooking.status,
            startsAt: newBooking.starts_at.toISOString(),
            endsAt: newBooking.ends_at.toISOString(),
          },
          actorUserId: ctx.user.id,
        });

        await enqueueBookingOutboxEvent(tx, {
          booking: newBooking,
          eventType: "booking_created",
          actorUserId: ctx.user.id,
          payload: {
            bookingId: newBooking.id,
            businessId: newBooking.business_id,
            locationId: newBooking.location_id,
            status: newBooking.status,
            startsAt: newBooking.starts_at.toISOString(),
            endsAt: newBooking.ends_at.toISOString(),
          },
        });

        return newBooking;
      });

      return mapBooking(created);
    }),

  updateStatus: operationalRole
    .input(
      z.object({
        bookingId: z.number().int().positive(),
        status: bookingStatusSchema,
      }),
    )
    .output(bookingSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const existing = await loadBookingOwned(input.bookingId, businessId);
      assertLocationAllowed(ctx, existing.location_id);

      if (input.status === "completed" && existing.service_agreement_id == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Completed status requires a service agreement",
        });
      }

      const updated = await db.transaction(async (tx) => {
        const [next] = await tx
          .update(bookings)
          .set({ status: input.status })
          .where(eq(bookings.id, input.bookingId))
          .returning();

        const eventTypeByStatus: Partial<
          Record<z.infer<typeof bookingStatusSchema>, z.infer<typeof bookingEventTypeSchema>>
        > = {
          confirmed: "confirm",
          checked_in: "check_in",
          no_show: "no_show",
          completed: "completed",
          cancelled: "cancel",
        };
        const eventType = eventTypeByStatus[input.status];
        if (eventType) {
          await recordBookingEvent(tx, {
            bookingId: next.id,
            businessId,
            eventType,
            payload: {
              previousStatus: existing.status,
              nextStatus: next.status,
            },
            actorUserId: ctx.user.id,
          });
        }

        if (input.status === "confirmed") {
          await enqueueBookingOutboxEvent(tx, {
            booking: next,
            eventType: "booking_confirmed",
            actorUserId: ctx.user.id,
            payload: {
              bookingId: next.id,
              businessId: next.business_id,
              locationId: next.location_id,
              status: next.status,
            },
          });
        }

        return next;
      });

      return mapBooking(updated);
    }),

  reschedule: operationalRole
    .input(
      z
        .object({
          bookingId: z.number().int().positive(),
          startsAt: z.date(),
          endsAt: z.date(),
        })
        .refine((value) => value.endsAt > value.startsAt, {
          message: "End date must be after start date",
          path: ["endsAt"],
        }),
    )
    .output(bookingSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const existing = await loadBookingOwned(input.bookingId, businessId);
      assertLocationAllowed(ctx, existing.location_id);

      if (existing.staff_id != null) {
        await assertBookingNoOverlap({
          businessId,
          locationId: existing.location_id,
          staffId: existing.staff_id,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          excludeBookingId: existing.id,
        });
      }

      const updated = await db.transaction(async (tx) => {
        const [next] = await tx
          .update(bookings)
          .set({ starts_at: input.startsAt, ends_at: input.endsAt })
          .where(eq(bookings.id, input.bookingId))
          .returning();

        await recordBookingEvent(tx, {
          bookingId: next.id,
          businessId,
          eventType: "reschedule",
          payload: {
            previousStartsAt: existing.starts_at.toISOString(),
            previousEndsAt: existing.ends_at.toISOString(),
            nextStartsAt: next.starts_at.toISOString(),
            nextEndsAt: next.ends_at.toISOString(),
          },
          actorUserId: ctx.user.id,
        });

        await enqueueBookingOutboxEvent(tx, {
          booking: next,
          eventType: "booking_rescheduled",
          actorUserId: ctx.user.id,
          payload: {
            bookingId: next.id,
            businessId: next.business_id,
            locationId: next.location_id,
            startsAt: next.starts_at.toISOString(),
            endsAt: next.ends_at.toISOString(),
          },
        });

        return next;
      });

      return mapBooking(updated);
    }),

  cancel: operationalRole
    .input(z.object({ bookingId: z.number().int().positive() }))
    .output(bookingSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const existing = await loadBookingOwned(input.bookingId, businessId);
      assertLocationAllowed(ctx, existing.location_id);

      const updated = await db.transaction(async (tx) => {
        const [next] = await tx
          .update(bookings)
        .set({ status: "cancelled" })
          .where(eq(bookings.id, input.bookingId))
          .returning();

        await recordBookingEvent(tx, {
          bookingId: next.id,
          businessId,
          eventType: "cancel",
          payload: {
            previousStatus: existing.status,
            nextStatus: next.status,
          },
          actorUserId: ctx.user.id,
        });

        await enqueueBookingOutboxEvent(tx, {
          booking: next,
          eventType: "booking_cancelled",
          actorUserId: ctx.user.id,
          payload: {
            bookingId: next.id,
            businessId: next.business_id,
            locationId: next.location_id,
            status: next.status,
          },
        });

        return next;
      });

      return mapBooking(updated);
    }),

  convertToServiceAgreement: operationalRole
    .input(z.object({ bookingId: z.number().int().positive() }))
    .output(
      z.object({
        booking: bookingSchema,
        serviceAgreementId: z.number(),
        created: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const existing = await loadBookingOwned(input.bookingId, businessId);
      assertLocationAllowed(ctx, existing.location_id);
      await assertMembership(ctx.user.id, businessId);

      if (existing.service_agreement_id != null) {
        return {
          booking: mapBooking(existing),
          serviceAgreementId: existing.service_agreement_id,
          created: false,
        };
      }

      const result = await db.transaction(async (tx) => {
        const [agreement] = await tx
          .insert(serviceAgreements)
          .values({
            business_id: existing.business_id,
            location_id: existing.location_id,
            customer_id: existing.customer_id,
            created_by_user_id: ctx.user.id,
            service_name: existing.title,
            total_agreed_amount: 1,
            total_paid_amount: 0,
            pending_amount: 1,
            default_commission_rate_bps: 3000,
            status: "active",
            notes: existing.notes,
          })
          .returning({ id: serviceAgreements.id });

        const [updatedBooking] = await tx
          .update(bookings)
          .set({ service_agreement_id: agreement.id })
          .where(eq(bookings.id, existing.id))
          .returning();

        await recordBookingEvent(tx, {
          bookingId: updatedBooking.id,
          businessId,
          eventType: "convert_to_service",
          payload: {
            serviceAgreementId: agreement.id,
          },
          actorUserId: ctx.user.id,
        });

        return { agreementId: agreement.id, updatedBooking };
      });

      return {
        booking: mapBooking(result.updatedBooking),
        serviceAgreementId: result.agreementId,
        created: true,
      };
    }),

  registerExternalResponse: operationalRole
    .input(
      z
        .object({
          bookingId: z.number().int().positive(),
          response: z.enum(["confirm", "reschedule", "cancel", "unconfirmed"]),
          startsAt: z.date().optional(),
          endsAt: z.date().optional(),
        })
        .refine(
          (value) =>
            value.response !== "reschedule" ||
            (value.startsAt != null &&
              value.endsAt != null &&
              value.endsAt > value.startsAt),
          {
            message: "Reschedule requires a valid start and end date",
            path: ["startsAt"],
          },
        ),
    )
    .output(bookingSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const existing = await loadBookingOwned(input.bookingId, businessId);
      assertLocationAllowed(ctx, existing.location_id);

      const updated = await db.transaction(async (tx) => {
        if (input.response === "confirm") {
          const [next] = await tx
            .update(bookings)
            .set({ status: "confirmed", confirmation_status: "confirmed" })
            .where(eq(bookings.id, existing.id))
            .returning();
          await recordBookingEvent(tx, {
            bookingId: next.id,
            businessId,
            eventType: "confirm",
            payload: { source: "external_response" },
            actorUserId: ctx.user.id,
          });
          await enqueueBookingOutboxEvent(tx, {
            booking: next,
            eventType: "booking_confirmed",
            actorUserId: ctx.user.id,
            payload: { bookingId: next.id, source: "external_response" },
          });
          return next;
        }

        if (input.response === "reschedule") {
          const [next] = await tx
            .update(bookings)
        .set({
              starts_at: input.startsAt!,
              ends_at: input.endsAt!,
              status: "pending",
              confirmation_status: "pending",
            })
            .where(eq(bookings.id, existing.id))
            .returning();
          await recordBookingEvent(tx, {
            bookingId: next.id,
            businessId,
            eventType: "reschedule",
            payload: { source: "external_response" },
            actorUserId: ctx.user.id,
          });
          await enqueueBookingOutboxEvent(tx, {
            booking: next,
            eventType: "booking_rescheduled",
            actorUserId: ctx.user.id,
            payload: { bookingId: next.id, source: "external_response" },
          });
          return next;
        }

        if (input.response === "cancel") {
          const [next] = await tx
            .update(bookings)
            .set({ status: "cancelled", confirmation_status: "unconfirmed" })
            .where(eq(bookings.id, existing.id))
            .returning();
          await recordBookingEvent(tx, {
            bookingId: next.id,
            businessId,
            eventType: "cancel",
            payload: { source: "external_response" },
            actorUserId: ctx.user.id,
          });
          await enqueueBookingOutboxEvent(tx, {
            booking: next,
            eventType: "booking_cancelled",
            actorUserId: ctx.user.id,
            payload: { bookingId: next.id, source: "external_response" },
          });
          return next;
        }

        const [next] = await tx
          .update(bookings)
          .set({ confirmation_status: "unconfirmed" })
          .where(eq(bookings.id, existing.id))
          .returning();
        return next;
      });

      return mapBooking(updated);
    }),

  summary: protectedProcedure
    .input(
      z.object({
        startsAt: z.date(),
        endsAt: z.date(),
        locationId: z.number().int().positive().optional(),
        staffId: z.number().int().positive().optional(),
      }),
    )
    .output(
      z.object({
        totalBookings: z.number(),
        confirmedRate: z.number(),
        noShowRate: z.number(),
        conversionToServiceAgreementRate: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      if (input.locationId !== undefined) {
        assertLocationAllowed(ctx, input.locationId);
      }

      const where = and(
        eq(bookings.business_id, businessId),
        gte(bookings.starts_at, input.startsAt),
        lte(bookings.starts_at, input.endsAt),
        input.locationId !== undefined
          ? eq(bookings.location_id, input.locationId)
          : ctx.isLocationScoped && ctx.effectiveLocationIds.length > 0
            ? inArray(bookings.location_id, ctx.effectiveLocationIds)
            : undefined,
        input.staffId !== undefined ? eq(bookings.staff_id, input.staffId) : undefined,
      );

      const rows = await db.select().from(bookings).where(where);
      const total = rows.length;
      if (total === 0) {
        return {
          totalBookings: 0,
          confirmedRate: 0,
          noShowRate: 0,
          conversionToServiceAgreementRate: 0,
        };
      }

      const confirmedCount = rows.filter((row) => row.status === "confirmed").length;
      const noShowCount = rows.filter((row) => row.status === "no_show").length;
      const convertedCount = rows.filter(
        (row) => row.service_agreement_id != null,
      ).length;

      return {
        totalBookings: total,
        confirmedRate: confirmedCount / total,
        noShowRate: noShowCount / total,
        conversionToServiceAgreementRate: convertedCount / total,
      };
    }),
});
