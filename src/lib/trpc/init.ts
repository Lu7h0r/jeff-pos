import { initTRPC, TRPCError } from "@trpc/server";
import type { OpenApiMeta } from "trpc-to-openapi";
import superjson from "superjson";
import { cookies } from "next/headers";
import { getAuthUser } from "@/lib/auth-guard";
import { resolveActiveContext } from "./active-context";

const ACTIVE_LOCATION_COOKIE = "jeff_active_location_id";

export interface TRPCContext {
  user: Awaited<ReturnType<typeof getAuthUser>>;
  activeBusinessId: number | null;
  activeLocationId: number | null;
  activeRole: string | null;
}

export const createTRPCContext = async (): Promise<TRPCContext> => {
  const user = await getAuthUser();

  if (!user) {
    return {
      user: null,
      activeBusinessId: null,
      activeLocationId: null,
      activeRole: null,
    };
  }

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(ACTIVE_LOCATION_COOKIE)?.value;
  const locationIdHint = cookieValue ? Number(cookieValue) : null;
  const safeHint =
    locationIdHint !== null && Number.isFinite(locationIdHint)
      ? locationIdHint
      : null;

  const active = await resolveActiveContext(user.id, safeHint);

  return {
    user,
    activeBusinessId: active?.businessId ?? null,
    activeLocationId: active?.locationId ?? null,
    activeRole: active?.role ?? null,
  };
};

const t = initTRPC.context<TRPCContext>().meta<OpenApiMeta>().create({
  transformer: superjson,
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
