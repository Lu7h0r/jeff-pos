import { describe, it, expect } from "bun:test";
import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { makeContext } from "./helpers";
import {
  requireRole,
  ownerOnly,
  operationalRole,
} from "../../role-guards";
import { router, createCallerFactory } from "../../init";

const cashierProcedure = requireRole(["cashier"]);

const testRouter = router({
  cashierOnly: cashierProcedure
    .input(z.void())
    .output(z.literal("ok"))
    .query(() => "ok" as const),
  ownerOnly: ownerOnly
    .input(z.void())
    .output(z.literal("ok"))
    .query(() => "ok" as const),
  operational: operationalRole
    .input(z.void())
    .output(z.literal("ok"))
    .query(() => "ok" as const),
});

const factory = createCallerFactory(testRouter);

describe("requireRole middleware", () => {
  it("allows when ctx.activeRole matches one of the allowed roles", async () => {
    const caller = factory(makeContext("u1", { role: "cashier" }));
    expect(await caller.cashierOnly()).toBe("ok");
  });

  it("rejects FORBIDDEN when role does not match", async () => {
    const caller = factory(makeContext("u1", { role: "owner" }));
    await expect(caller.cashierOnly()).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<TRPCError>);
  });

  it("rejects FORBIDDEN when no activeRole is present", async () => {
    const caller = factory(makeContext("u1", { role: null }));
    await expect(caller.ownerOnly()).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<TRPCError>);
  });

  it("ownerOnly preset allows owner and rejects manager", async () => {
    const ownerCaller = factory(makeContext("u1", { role: "owner" }));
    expect(await ownerCaller.ownerOnly()).toBe("ok");

    const managerCaller = factory(makeContext("u1", { role: "manager" }));
    await expect(managerCaller.ownerOnly()).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<TRPCError>);
  });

  it("operationalRole preset allows owner/manager/cashier and rejects artist", async () => {
    for (const role of ["owner", "manager", "cashier"] as const) {
      const caller = factory(makeContext("u1", { role }));
      expect(await caller.operational()).toBe("ok");
    }
    const artistCaller = factory(makeContext("u1", { role: "artist" }));
    await expect(artistCaller.operational()).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<TRPCError>);
  });
});
