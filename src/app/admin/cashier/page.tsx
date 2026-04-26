"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useTRPC } from "@/lib/trpc/client";
import { useCrudMutation } from "@/hooks/use-crud-mutation";
import { formatDate } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc/router";

type CashSession = NonNullable<RouterOutputs["cashSessions"]["current"]>;

const ACTIVE_LOCATION_COOKIE = "jeff_active_location_id";

function readActiveLocationCookie(): number | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/jeff_active_location_id=(\d+)/);
  return match ? Number(match[1]) : null;
}

function formatAmount(minorUnits: number): string {
  return `$${(minorUnits / 100).toFixed(2)}`;
}

export default function CashierPage() {
  const [locationId, setLocationId] = useState<number | null>(null);

  useEffect(() => {
    setLocationId(readActiveLocationCookie());
  }, []);

  if (locationId === null) {
    return <NoLocationSelected />;
  }

  return <CashierForLocation locationId={locationId} />;
}

function NoLocationSelected() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Caja</CardTitle>
        <CardDescription>Select a location to operate the cash drawer.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          No active location is set. Use the location selector in the header to
          pick Amparo or Britalia first.
        </p>
      </CardContent>
    </Card>
  );
}

function CashierForLocation({ locationId }: { locationId: number }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const currentQueryOptions = trpc.cashSessions.current.queryOptions({ locationId });
  const { data: session, isLoading } = useQuery(currentQueryOptions);

  const invalidateCurrent = () =>
    queryClient.invalidateQueries({ queryKey: currentQueryOptions.queryKey });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!session) {
    return <OpenSessionForm locationId={locationId} onOpened={invalidateCurrent} />;
  }

  return <OpenSessionView session={session} onClosed={invalidateCurrent} />;
}

interface OpenSessionFormProps {
  locationId: number;
  onOpened: () => void;
}

function OpenSessionForm({ locationId, onOpened }: OpenSessionFormProps) {
  const trpc = useTRPC();
  const [openingAmount, setOpeningAmount] = useState<string>("0");
  const [notes, setNotes] = useState<string>("");

  const openMutation = useCrudMutation({
    mutationOptions: trpc.cashSessions.open.mutationOptions(),
    invalidateKeys: trpc.cashSessions.current.queryOptions({ locationId }).queryKey,
    successMessage: "Cash session opened",
    errorMessage: "Failed to open cash session",
    onSuccess: () => {
      setOpeningAmount("0");
      setNotes("");
      onOpened();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Math.round(Number(openingAmount) * 100);
    if (!Number.isFinite(amount) || amount < 0) return;

    openMutation.mutate({
      locationId,
      openingCashAmount: amount,
      notes: notes.trim() ? notes.trim() : undefined,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Open cash drawer</CardTitle>
        <CardDescription>
          Start a new cash session for this location. The opening amount is the
          cash physically in the drawer right now.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 max-w-md" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="opening-amount">Opening cash</Label>
            <Input
              id="opening-amount"
              type="number"
              min="0"
              step="0.01"
              value={openingAmount}
              onChange={(e) => setOpeningAmount(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="opening-notes">Notes (optional)</Label>
            <Input
              id="opening-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Shift, opener, anything worth recording"
            />
          </div>
          <Button type="submit" disabled={openMutation.isPending}>
            {openMutation.isPending ? (
              <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            Open session
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

interface OpenSessionViewProps {
  session: CashSession;
  onClosed: () => void;
}

function OpenSessionView({ session, onClosed }: OpenSessionViewProps) {
  const trpc = useTRPC();
  const [countedAmount, setCountedAmount] = useState<string>("0");
  const [notes, setNotes] = useState<string>("");

  const closeMutation = useCrudMutation({
    mutationOptions: trpc.cashSessions.close.mutationOptions(),
    invalidateKeys: trpc.cashSessions.current.queryOptions({
      locationId: session.location_id,
    }).queryKey,
    successMessage: "Cash session closed",
    errorMessage: "Failed to close cash session",
    onSuccess: () => {
      setCountedAmount("0");
      setNotes("");
      onClosed();
    },
  });

  const handleClose = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Math.round(Number(countedAmount) * 100);
    if (!Number.isFinite(amount) || amount < 0) return;

    closeMutation.mutate({
      cashSessionId: session.id,
      countedCashAmount: amount,
      notes: notes.trim() ? notes.trim() : undefined,
    });
  };

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Open cash session</CardTitle>
              <CardDescription>
                Opened {session.opened_at ? formatDate(session.opened_at) : "—"} by {session.opened_by_user_id}
              </CardDescription>
            </div>
            <Badge>open</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Opening cash</dt>
              <dd className="font-medium">{formatAmount(session.opening_cash_amount)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Expected cash</dt>
              <dd className="font-medium">{formatAmount(session.expected_cash_amount)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Expected digital</dt>
              <dd className="font-medium">{formatAmount(session.expected_digital_amount)}</dd>
            </div>
          </dl>
          {session.notes ? (
            <p className="mt-4 text-sm text-muted-foreground whitespace-pre-line">
              {session.notes}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Close session</CardTitle>
          <CardDescription>
            Count the cash physically in the drawer. The difference will be
            stored for auditing; closing does not modify any sale.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 max-w-md" onSubmit={handleClose}>
            <div className="grid gap-2">
              <Label htmlFor="counted-amount">Counted cash</Label>
              <Input
                id="counted-amount"
                type="number"
                min="0"
                step="0.01"
                value={countedAmount}
                onChange={(e) => setCountedAmount(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="closing-notes">Notes (optional)</Label>
              <Input
                id="closing-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Discrepancies, observations"
              />
            </div>
            <Button type="submit" variant="destructive" disabled={closeMutation.isPending}>
              {closeMutation.isPending ? (
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Close session
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cash movements</CardTitle>
          <CardDescription>
            Sales, refunds and manual movements appear here. The movements
            ledger is wired to POS in Batch 4; this section is currently empty.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No movements recorded for this session yet.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
