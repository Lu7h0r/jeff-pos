import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import {
  bookings,
  businessMembers,
  customers,
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
  service_agreement_id: z.number().nullable(),
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

  create: operationalRole
    .input(
      z
        .object({
          locationId: z.number().int().positive(),
          customerId: z.number().int().positive().optional(),
          staffId: z.number().int().positive().optional(),
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

      if (input.staffId !== undefined) {
        const [staff] = await db
          .select({ id: staffMembers.id })
          .from(staffMembers)
          .where(
            and(
              eq(staffMembers.id, input.staffId),
              eq(staffMembers.business_id, businessId),
            ),
          )
          .limit(1);
        if (!staff) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Staff member belongs to a different business",
          });
        }
      }

      const [created] = await db
        .insert(bookings)
        .values({
          business_id: businessId,
          location_id: input.locationId,
          customer_id: input.customerId ?? null,
          staff_id: input.staffId ?? null,
          service_kind: input.serviceKind,
          title: input.title,
          notes: input.notes ?? null,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
          status: "pending",
        })
        .returning();

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

      const [updated] = await db
        .update(bookings)
        .set({ status: input.status })
        .where(eq(bookings.id, input.bookingId))
        .returning();

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

      const [updated] = await db
        .update(bookings)
        .set({ starts_at: input.startsAt, ends_at: input.endsAt })
        .where(eq(bookings.id, input.bookingId))
        .returning();

      return mapBooking(updated);
    }),

  cancel: operationalRole
    .input(z.object({ bookingId: z.number().int().positive() }))
    .output(bookingSchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const existing = await loadBookingOwned(input.bookingId, businessId);
      assertLocationAllowed(ctx, existing.location_id);

      const [updated] = await db
        .update(bookings)
        .set({ status: "cancelled" })
        .where(eq(bookings.id, input.bookingId))
        .returning();

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

      const [agreement] = await db
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

      const [updatedBooking] = await db
        .update(bookings)
        .set({ service_agreement_id: agreement.id })
        .where(eq(bookings.id, existing.id))
        .returning();

      return {
        booking: mapBooking(updatedBooking),
        serviceAgreementId: agreement.id,
        created: true,
      };
    }),
});
