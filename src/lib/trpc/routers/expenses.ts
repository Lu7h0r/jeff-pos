import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import {
  expenseCategories,
  expenseEntries,
  cashSessions,
  cashMovements,
  paymentMethods,
  locations,
} from "@/lib/db/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";

// Allowed enum values (single source of truth at zod layer).
const expenseKindSchema = z.enum(["operational", "recurring", "one_off"]);

const expenseCategorySchema = z.object({
  id: z.number(),
  business_id: z.number(),
  name: z.string(),
  kind: expenseKindSchema,
  archived: z.boolean(),
  created_at: z.date().nullable(),
});

const expenseEntrySchema = z.object({
  id: z.number(),
  business_id: z.number(),
  location_id: z.number().nullable(),
  category_id: z.number(),
  amount: z.number(),
  payment_method_id: z.number().nullable(),
  cash_session_id: z.number().nullable(),
  description: z.string().nullable(),
  incurred_at: z.date(),
  created_by_user_id: z.string(),
  created_at: z.date().nullable(),
});

const expenseEntryWithCategorySchema = expenseEntrySchema.extend({
  category_name: z.string(),
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

const categoriesRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/expenses/categories",
        tags: ["Expenses"],
        summary: "List expense categories of the active business",
      },
    })
    .input(z.void())
    .output(z.array(expenseCategorySchema))
    .query(async ({ ctx }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const rows = await db
        .select()
        .from(expenseCategories)
        .where(
          and(
            eq(expenseCategories.business_id, businessId),
            eq(expenseCategories.archived, false),
          ),
        )
        .orderBy(expenseCategories.name);
      return rows.map((row) => ({
        ...row,
        kind: expenseKindSchema.parse(row.kind),
      }));
    }),

  create: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/expenses/categories",
        tags: ["Expenses"],
        summary: "Create an expense category",
      },
    })
    .input(
      z.object({
        name: z.string().min(1).max(100),
        kind: expenseKindSchema.optional(),
      }),
    )
    .output(expenseCategorySchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);
      const [created] = await db
        .insert(expenseCategories)
        .values({
          business_id: businessId,
          name: input.name.trim(),
          kind: input.kind ?? "operational",
        })
        .returning();
      return {
        ...created,
        kind: expenseKindSchema.parse(created.kind),
      };
    }),
});

const entriesRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/expenses/entries",
        tags: ["Expenses"],
        summary: "List expense entries with optional location/date filters",
      },
    })
    .input(
      z.object({
        locationId: z.number().int().positive().optional(),
        rangeFrom: z.date().optional(),
        rangeTo: z.date().optional(),
      }),
    )
    .output(z.array(expenseEntryWithCategorySchema))
    .query(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      const conditions = [eq(expenseEntries.business_id, businessId)];
      if (input.locationId !== undefined) {
        conditions.push(eq(expenseEntries.location_id, input.locationId));
      }
      if (input.rangeFrom !== undefined) {
        conditions.push(gte(expenseEntries.incurred_at, input.rangeFrom));
      }
      if (input.rangeTo !== undefined) {
        conditions.push(lte(expenseEntries.incurred_at, input.rangeTo));
      }

      const rows = await db
        .select({
          id: expenseEntries.id,
          business_id: expenseEntries.business_id,
          location_id: expenseEntries.location_id,
          category_id: expenseEntries.category_id,
          amount: expenseEntries.amount,
          payment_method_id: expenseEntries.payment_method_id,
          cash_session_id: expenseEntries.cash_session_id,
          description: expenseEntries.description,
          incurred_at: expenseEntries.incurred_at,
          created_by_user_id: expenseEntries.created_by_user_id,
          created_at: expenseEntries.created_at,
          category_name: expenseCategories.name,
        })
        .from(expenseEntries)
        .innerJoin(
          expenseCategories,
          eq(expenseCategories.id, expenseEntries.category_id),
        )
        .where(and(...conditions))
        .orderBy(desc(expenseEntries.incurred_at));

      return rows;
    }),

  create: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/expenses/entries",
        tags: ["Expenses"],
        summary: "Register an expense entry (with optional cash audit)",
      },
    })
    .input(
      z.object({
        categoryId: z.number().int().positive(),
        amount: z.number().int().positive(),
        incurredAt: z.date(),
        locationId: z.number().int().positive().optional(),
        paymentMethodId: z.number().int().positive().optional(),
        cashSessionId: z.number().int().positive().optional(),
        description: z.string().optional(),
      }),
    )
    .output(expenseEntrySchema)
    .mutation(async ({ ctx, input }) => {
      const businessId = requireBusiness(ctx.activeBusinessId);

      const [category] = await db
        .select()
        .from(expenseCategories)
        .where(eq(expenseCategories.id, input.categoryId))
        .limit(1);
      if (!category) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Expense category not found",
        });
      }
      if (category.business_id !== businessId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Category belongs to a different business",
        });
      }

      if (input.locationId !== undefined) {
        const [loc] = await db
          .select()
          .from(locations)
          .where(eq(locations.id, input.locationId))
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

      // Cash classification heuristic (DA-9, mirrors orders.create).
      // Any payment method whose lowercased name contains "cash" feeds the
      // cash drawer ledger; everything else is treated as digital and does
      // NOT touch cash_movements (audit only relevant for physical cash).
      const isCashMethod =
        !!paymentMethod && paymentMethod.name.toLowerCase().includes("cash");

      return await db.transaction(async (tx) => {
        const [entry] = await tx
          .insert(expenseEntries)
          .values({
            business_id: businessId,
            location_id: input.locationId ?? null,
            category_id: input.categoryId,
            amount: input.amount,
            payment_method_id: input.paymentMethodId ?? null,
            cash_session_id: input.cashSessionId ?? null,
            description: input.description ?? null,
            incurred_at: input.incurredAt,
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
          const balanceAfter = balanceBefore - input.amount;

          await tx.insert(cashMovements).values({
            business_id: businessId,
            location_id: session.location_id,
            cash_session_id: session.id,
            type: "manual_out",
            payment_method_id: input.paymentMethodId ?? null,
            source_type: "expense",
            source_id: entry.id,
            amount: -input.amount,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
            transaction_type: "negative",
            created_by_user_id: ctx.user.id,
            notes: input.description ?? null,
          });

          await tx
            .update(cashSessions)
            .set({
              expected_cash_amount:
                session.expected_cash_amount - input.amount,
            })
            .where(eq(cashSessions.id, session.id));
        }

        return entry;
      });
    }),
});

export const expensesRouter = router({
  categories: categoriesRouter,
  entries: entriesRouter,
});
