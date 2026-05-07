import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { desc, eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { protectedProcedure, router } from "../init";
import { operationalRole } from "../role-guards";
import { assertLocationAllowed } from "../scope-guards";
import {
  serviceAgreements,
  serviceAgreementPayments,
  serviceAgreementSessions,
  serviceAgreementCommissions,
  locations,
  businessMembers,
  paymentMethods,
  cashSessions,
  orders,
  orderPayments,
  cashMovements,
  customers,
  staffMembers,
} from "@/lib/db/schema";

const agreementStatusSchema = z.enum(["active", "completed", "cancelled"]);

const agreementSchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  customer_id: z.number().nullable(),
  created_by_user_id: z.string(),
  service_name: z.string(),
  total_agreed_amount: z.number(),
  total_paid_amount: z.number(),
  pending_amount: z.number(),
  default_commission_rate_bps: z.number(),
  status: agreementStatusSchema,
  notes: z.string().nullable(),
  created_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

const agreementPaymentSchema = z.object({
  id: z.number(),
  service_agreement_id: z.number(),
  order_id: z.number(),
  payment_method_id: z.number(),
  cash_session_id: z.number(),
  amount: z.number(),
  created_by_user_id: z.string(),
  notes: z.string().nullable(),
  created_at: z.date().nullable(),
});

const agreementWithPaymentsSchema = agreementSchema.extend({
  payments: z.array(agreementPaymentSchema),
});

const agreementSessionStatusSchema = z.enum([
  "scheduled",
  "completed",
  "cancelled",
]);

const agreementSessionSchema = z.object({
  id: z.number(),
  service_agreement_id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  staff_member_id: z.number(),
  scheduled_for: z.date().nullable(),
  session_amount: z.number(),
  commission_rate_bps: z.number(),
  status: agreementSessionStatusSchema,
  notes: z.string().nullable(),
  created_by_user_id: z.string(),
  created_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

const agreementCommissionSchema = z.object({
  id: z.number(),
  service_agreement_id: z.number(),
  service_agreement_session_id: z.number(),
  business_id: z.number(),
  location_id: z.number(),
  staff_member_id: z.number(),
  commission_base_amount: z.number(),
  commission_rate_bps: z.number(),
  commission_amount: z.number(),
  status: z.enum(["estimated", "liquidated", "voided"]),
  notes: z.string().nullable(),
  calculated_by_user_id: z.string(),
  created_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

const agreementSessionWithCommissionSchema = z.object({
  session: agreementSessionSchema,
  commission: agreementCommissionSchema,
});

function computeCommissionAmount(baseAmount: number, rateBps: number): number {
  return Math.floor((baseAmount * rateBps) / 10_000);
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

export const serviceAgreementsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        locationId: z.number().int().positive().optional(),
      }),
    )
    .output(z.array(agreementSchema))
    .query(async ({ ctx, input }) => {
      if (ctx.activeBusinessId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "An active business is required",
        });
      }

      if (input.locationId !== undefined) {
        assertLocationAllowed(ctx, input.locationId);
      }

      const rows = await db.query.serviceAgreements.findMany({
        where:
          input.locationId !== undefined
            ? and(
                eq(serviceAgreements.business_id, ctx.activeBusinessId),
                eq(serviceAgreements.location_id, input.locationId),
              )
            : ctx.isLocationScoped && ctx.effectiveLocationIds.length > 0
              ? and(
                  eq(serviceAgreements.business_id, ctx.activeBusinessId),
                  inArray(
                    serviceAgreements.location_id,
                    ctx.effectiveLocationIds,
                  ),
                )
              : eq(serviceAgreements.business_id, ctx.activeBusinessId),
        orderBy: [desc(serviceAgreements.id)],
      });

      return rows.map((row) => ({
        ...row,
        status: agreementStatusSchema.parse(row.status),
      }));
    }),

  get: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .output(agreementWithPaymentsSchema)
    .query(async ({ ctx, input }) => {
      const [agreement] = await db
        .select()
        .from(serviceAgreements)
        .where(eq(serviceAgreements.id, input.id))
        .limit(1);
      if (!agreement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agreement not found" });
      }

      await assertMembership(ctx.user.id, agreement.business_id);
      assertLocationAllowed(ctx, agreement.location_id);

      const payments = await db
        .select()
        .from(serviceAgreementPayments)
        .where(eq(serviceAgreementPayments.service_agreement_id, agreement.id));

      return {
        ...agreement,
        status: agreementStatusSchema.parse(agreement.status),
        payments,
      };
    }),

  create: operationalRole
    .input(
      z.object({
        locationId: z.number().int().positive(),
        customerId: z.number().int().positive().optional(),
        serviceName: z.string().trim().min(1).max(255),
        totalAgreedAmount: z.number().int().positive(),
        defaultCommissionRateBps: z.number().int().min(0).max(10_000).optional(),
        notes: z.string().optional(),
      }),
    )
    .output(agreementSchema)
    .mutation(async ({ ctx, input }) => {
      assertLocationAllowed(ctx, input.locationId);

      const [loc] = await db
        .select()
        .from(locations)
        .where(eq(locations.id, input.locationId))
        .limit(1);
      if (!loc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }
      await assertMembership(ctx.user.id, loc.business_id);

      if (input.customerId !== undefined) {
        const [customer] = await db
          .select()
          .from(customers)
          .where(eq(customers.id, input.customerId))
          .limit(1);
        if (!customer) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
        }
        if (customer.business_id !== loc.business_id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Customer belongs to a different business",
          });
        }
      }

      const [created] = await db
        .insert(serviceAgreements)
        .values({
          business_id: loc.business_id,
          location_id: loc.id,
          customer_id: input.customerId ?? null,
          created_by_user_id: ctx.user.id,
          service_name: input.serviceName,
          total_agreed_amount: input.totalAgreedAmount,
          total_paid_amount: 0,
          pending_amount: input.totalAgreedAmount,
          default_commission_rate_bps: input.defaultCommissionRateBps ?? 3000,
          status: "active",
          notes: input.notes ?? null,
        })
        .returning();

      return {
        ...created,
        status: agreementStatusSchema.parse(created.status),
      };
    }),

  createSession: operationalRole
    .input(
      z.object({
        agreementId: z.number().int().positive(),
        staffMemberId: z.number().int().positive(),
        scheduledFor: z.date(),
        sessionAmount: z.number().int().min(0),
        commissionRateBps: z.number().int().min(0).max(10_000).optional(),
        notes: z.string().optional(),
      }),
    )
    .output(agreementSessionWithCommissionSchema)
    .mutation(async ({ ctx, input }) => {
      const [agreement] = await db
        .select()
        .from(serviceAgreements)
        .where(eq(serviceAgreements.id, input.agreementId))
        .limit(1);
      if (!agreement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agreement not found" });
      }
      await assertMembership(ctx.user.id, agreement.business_id);
      assertLocationAllowed(ctx, agreement.location_id);

      const [staff] = await db
        .select()
        .from(staffMembers)
        .where(eq(staffMembers.id, input.staffMemberId))
        .limit(1);
      if (!staff) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Staff member not found" });
      }
      if (staff.business_id !== agreement.business_id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Staff member belongs to a different business",
        });
      }

      const commissionRateBps =
        input.commissionRateBps ?? agreement.default_commission_rate_bps;
      const commissionAmount = computeCommissionAmount(
        input.sessionAmount,
        commissionRateBps,
      );

      return await db.transaction(async (tx) => {
        const [session] = await tx
          .insert(serviceAgreementSessions)
          .values({
            service_agreement_id: agreement.id,
            business_id: agreement.business_id,
            location_id: agreement.location_id,
            staff_member_id: input.staffMemberId,
            scheduled_for: input.scheduledFor,
            session_amount: input.sessionAmount,
            commission_rate_bps: commissionRateBps,
            status: "scheduled",
            notes: input.notes ?? null,
            created_by_user_id: ctx.user.id,
          })
          .returning();

        const [commission] = await tx
          .insert(serviceAgreementCommissions)
          .values({
            service_agreement_id: agreement.id,
            service_agreement_session_id: session.id,
            business_id: agreement.business_id,
            location_id: agreement.location_id,
            staff_member_id: input.staffMemberId,
            commission_base_amount: input.sessionAmount,
            commission_rate_bps: commissionRateBps,
            commission_amount: commissionAmount,
            status: "estimated",
            notes: input.notes ?? null,
            calculated_by_user_id: ctx.user.id,
          })
          .returning();

        return {
          session: {
            ...session,
            status: agreementSessionStatusSchema.parse(session.status),
          },
          commission: {
            ...commission,
            status: agreementCommissionSchema.shape.status.parse(commission.status),
          },
        };
      });
    }),

  listSessions: protectedProcedure
    .input(
      z.object({
        agreementId: z.number().int().positive(),
      }),
    )
    .output(z.array(agreementSessionWithCommissionSchema))
    .query(async ({ ctx, input }) => {
      const [agreement] = await db
        .select()
        .from(serviceAgreements)
        .where(eq(serviceAgreements.id, input.agreementId))
        .limit(1);
      if (!agreement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agreement not found" });
      }
      await assertMembership(ctx.user.id, agreement.business_id);
      assertLocationAllowed(ctx, agreement.location_id);

      const rows = await db
        .select({
          session: serviceAgreementSessions,
          commission: serviceAgreementCommissions,
        })
        .from(serviceAgreementSessions)
        .innerJoin(
          serviceAgreementCommissions,
          eq(
            serviceAgreementCommissions.service_agreement_session_id,
            serviceAgreementSessions.id,
          ),
        )
        .where(eq(serviceAgreementSessions.service_agreement_id, agreement.id))
        .orderBy(desc(serviceAgreementSessions.scheduled_for));

      return rows.map((row) => ({
        session: {
          ...row.session,
          status: agreementSessionStatusSchema.parse(row.session.status),
        },
        commission: {
          ...row.commission,
          status: agreementCommissionSchema.shape.status.parse(
            row.commission.status,
          ),
        },
      }));
    }),

  updateSessionStatus: operationalRole
    .input(
      z.object({
        sessionId: z.number().int().positive(),
        status: agreementSessionStatusSchema,
      }),
    )
    .output(agreementSessionSchema)
    .mutation(async ({ ctx, input }) => {
      const [session] = await db
        .select()
        .from(serviceAgreementSessions)
        .where(eq(serviceAgreementSessions.id, input.sessionId))
        .limit(1);
      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }

      await assertMembership(ctx.user.id, session.business_id);
      assertLocationAllowed(ctx, session.location_id);

      const [updated] = await db
        .update(serviceAgreementSessions)
        .set({
          status: input.status,
          updated_at: sql`NOW()`,
        })
        .where(eq(serviceAgreementSessions.id, session.id))
        .returning();

      return {
        ...updated,
        status: agreementSessionStatusSchema.parse(updated.status),
      };
    }),

  getCommissionSummary: protectedProcedure
    .input(
      z.object({
        agreementId: z.number().int().positive(),
      }),
    )
    .output(
      z.object({
        agreementId: z.number(),
        estimatedCommissionAmount: z.number(),
        sessionCount: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [agreement] = await db
        .select()
        .from(serviceAgreements)
        .where(eq(serviceAgreements.id, input.agreementId))
        .limit(1);
      if (!agreement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agreement not found" });
      }

      await assertMembership(ctx.user.id, agreement.business_id);
      assertLocationAllowed(ctx, agreement.location_id);

      const [summary] = await db
        .select({
          estimatedCommissionAmount:
            sql<number>`COALESCE(SUM(${serviceAgreementCommissions.commission_amount}), 0)`,
          sessionCount: sql<number>`COUNT(*)`,
        })
        .from(serviceAgreementCommissions)
        .where(eq(serviceAgreementCommissions.service_agreement_id, agreement.id));

      return {
        agreementId: agreement.id,
        estimatedCommissionAmount: summary?.estimatedCommissionAmount ?? 0,
        sessionCount: summary?.sessionCount ?? 0,
      };
    }),

  addPayment: operationalRole
    .input(
      z.object({
        agreementId: z.number().int().positive(),
        paymentLines: z
          .array(
            z.object({
              paymentMethodId: z.number().int().positive(),
              amount: z.number().int().positive(),
            }),
          )
          .min(1),
        notes: z.string().optional(),
      }),
    )
    .output(agreementWithPaymentsSchema)
    .mutation(async ({ ctx, input }) => {
      const [agreement] = await db
        .select()
        .from(serviceAgreements)
        .where(eq(serviceAgreements.id, input.agreementId))
        .limit(1);
      if (!agreement) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agreement not found" });
      }
      await assertMembership(ctx.user.id, agreement.business_id);
      assertLocationAllowed(ctx, agreement.location_id);

      if (agreement.status !== "active") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Only active agreements can receive payments",
        });
      }

      const paymentMethodIds = Array.from(
        new Set(input.paymentLines.map((line) => line.paymentMethodId)),
      );
      const paymentMethodRows = await db
        .select()
        .from(paymentMethods)
        .where(inArray(paymentMethods.id, paymentMethodIds));
      const paymentMethodById = new Map(paymentMethodRows.map((pm) => [pm.id, pm]));

      for (const paymentMethodId of paymentMethodIds) {
        const method = paymentMethodById.get(paymentMethodId);
        if (!method) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Payment method ${paymentMethodId} not found`,
          });
        }
        if (
          method.business_id != null &&
          method.business_id !== agreement.business_id
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Payment method belongs to a different business",
          });
        }
      }

      const [openSession] = await db
        .select()
        .from(cashSessions)
        .where(
          and(
            eq(cashSessions.business_id, agreement.business_id),
            eq(cashSessions.location_id, agreement.location_id),
            eq(cashSessions.status, "open"),
          ),
        )
        .limit(1);

      if (!openSession) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "No open cash session for this location",
        });
      }

      const paymentTotal = input.paymentLines.reduce(
        (sum, line) => sum + line.amount,
        0,
      );
      if (paymentTotal > agreement.pending_amount) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Payment total exceeds pending amount",
        });
      }

      const isCashMethod = (id: number) => {
        const pm = paymentMethodById.get(id);
        return !!pm && pm.name.toLowerCase().includes("cash");
      };

      return await db.transaction(async (tx) => {
        const [orderRow] = await tx
          .insert(orders)
          .values({
            customer_id: agreement.customer_id,
            total_amount: paymentTotal,
            user_uid: ctx.user.id,
            business_id: agreement.business_id,
            location_id: agreement.location_id,
            cash_session_id: openSession.id,
            payment_status: "paid",
            process_status: "complete",
            notes: `Abono servicio #${agreement.id}${input.notes ? ` - ${input.notes}` : ""}`,
          })
          .returning();

        const insertedOrderPayments = await tx
          .insert(orderPayments)
          .values(
            input.paymentLines.map((line) => ({
              order_id: orderRow.id,
              payment_method_id: line.paymentMethodId,
              cash_session_id: openSession.id,
              amount: line.amount,
              created_by_user_id: ctx.user.id,
            })),
          )
          .returning();

        const insertedAgreementPayments = await tx
          .insert(serviceAgreementPayments)
          .values(
            input.paymentLines.map((line) => ({
              service_agreement_id: agreement.id,
              order_id: orderRow.id,
              payment_method_id: line.paymentMethodId,
              cash_session_id: openSession.id,
              amount: line.amount,
              created_by_user_id: ctx.user.id,
              notes: input.notes ?? null,
            })),
          )
          .returning();

        const cashAdded = insertedOrderPayments
          .filter((p) => isCashMethod(p.payment_method_id))
          .reduce((sum, p) => sum + p.amount, 0);
        const digitalAdded = insertedOrderPayments
          .filter((p) => !isCashMethod(p.payment_method_id))
          .reduce((sum, p) => sum + p.amount, 0);

        const lastMovement = await tx
          .select({ balance_after: cashMovements.balance_after })
          .from(cashMovements)
          .where(eq(cashMovements.cash_session_id, openSession.id))
          .orderBy(desc(cashMovements.id))
          .limit(1);
        let runningBalance =
          lastMovement[0]?.balance_after ?? openSession.opening_cash_amount;

        for (const line of insertedOrderPayments) {
          const balanceBefore = runningBalance;
          const balanceAfter = balanceBefore + line.amount;
          runningBalance = balanceAfter;
          await tx.insert(cashMovements).values({
            business_id: agreement.business_id,
            location_id: agreement.location_id,
            cash_session_id: openSession.id,
            type: "sale",
            payment_method_id: line.payment_method_id,
            source_type: "service_agreement_payment",
            source_id: agreement.id,
            amount: line.amount,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
            transaction_type: "positive",
            created_by_user_id: ctx.user.id,
            notes: `Abono servicio #${agreement.id}`,
          });
        }

        await tx
          .update(cashSessions)
          .set({
            expected_cash_amount:
              openSession.expected_cash_amount + cashAdded,
            expected_digital_amount:
              openSession.expected_digital_amount + digitalAdded,
          })
          .where(eq(cashSessions.id, openSession.id));

        const totalPaid = agreement.total_paid_amount + paymentTotal;
        const pending = agreement.total_agreed_amount - totalPaid;
        const nextStatus = pending === 0 ? "completed" : "active";

        const [updatedAgreement] = await tx
          .update(serviceAgreements)
          .set({
            total_paid_amount: totalPaid,
            pending_amount: pending,
            status: nextStatus,
            updated_at: sql`NOW()`,
          })
          .where(eq(serviceAgreements.id, agreement.id))
          .returning();

        return {
          ...updatedAgreement,
          status: agreementStatusSchema.parse(updatedAgreement.status),
          payments: insertedAgreementPayments,
        };
      });
    }),
});
