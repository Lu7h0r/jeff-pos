import { and, eq, isNull, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { followUpOutboxEvents } from "@/lib/db/schema";

function isAuthorized(request: Request): boolean {
  const token = process.env.INTERNAL_WEBHOOK_TOKEN;
  if (!token) return false;
  return request.headers.get("x-internal-token") === token;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const limitParam = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), 100)
    : 50;

  const rows = await db
    .select()
    .from(followUpOutboxEvents)
    .where(
      status
        ? eq(followUpOutboxEvents.status, status)
        : and(
            eq(followUpOutboxEvents.status, "pending"),
            or(
              isNull(followUpOutboxEvents.next_attempt_at),
              sql`${followUpOutboxEvents.next_attempt_at} <= NOW()`,
            ),
          ),
    )
    .limit(limit);

  return NextResponse.json({ events: rows });
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    status?: "pending" | "processing" | "dispatched" | "failed";
    error?: string;
  };

  if (!body.eventId || !body.status) {
    return NextResponse.json(
      { error: "eventId y status son requeridos" },
      { status: 400 },
    );
  }

  const nextAttemptAt =
    body.status === "failed"
      ? sql`NOW() + INTERVAL '5 minutes'`
      : body.status === "pending"
        ? sql`NOW()`
        : null;

  const [updated] = await db
    .update(followUpOutboxEvents)
    .set({
      status: body.status,
      attempts: sql`${followUpOutboxEvents.attempts} + 1`,
      dispatched_at: body.status === "dispatched" ? sql`NOW()` : null,
      last_error: body.error ?? null,
      next_attempt_at: nextAttemptAt,
      updated_at: sql`NOW()`,
    })
    .where(eq(followUpOutboxEvents.id, body.eventId))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "Evento no encontrado" }, { status: 404 });
  }

  return NextResponse.json({ event: updated });
}
