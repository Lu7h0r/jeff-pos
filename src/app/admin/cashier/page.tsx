"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
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
import { formatCurrency, formatDate } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc/router";

type CashSession = NonNullable<RouterOutputs["cashSessions"]["current"]>;

function readActiveLocationCookie(): number | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/jeff_active_location_id=(\d+)/);
  return match ? Number(match[1]) : null;
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
  const t = useTranslations("cashier");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("selectLocation")}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {t("noLocationDetail")}
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
  const t = useTranslations("cashier");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const [openingAmount, setOpeningAmount] = useState<string>("0");
  const [notes, setNotes] = useState<string>("");

  const openMutation = useCrudMutation({
    mutationOptions: trpc.cashSessions.open.mutationOptions(),
    invalidateKeys: trpc.cashSessions.current.queryOptions({ locationId }).queryKey,
    successMessage: t("openSessionSuccess"),
    errorMessage: t("openSessionError"),
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
        <CardTitle>{t("openTitle")}</CardTitle>
        <CardDescription>{t("openSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 max-w-md" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="opening-amount">{t("openingCash")}</Label>
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
            <Label htmlFor="opening-notes">{tc("notesOptional")}</Label>
            <Input
              id="opening-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("openingNotesPlaceholder")}
            />
          </div>
          <Button type="submit" disabled={openMutation.isPending}>
            {openMutation.isPending ? (
              <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            {t("openSession")}
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
  const t = useTranslations("cashier");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const [countedAmount, setCountedAmount] = useState<string>("0");
  const [notes, setNotes] = useState<string>("");

  const closeMutation = useCrudMutation({
    mutationOptions: trpc.cashSessions.close.mutationOptions(),
    invalidateKeys: trpc.cashSessions.current.queryOptions({
      locationId: session.location_id,
    }).queryKey,
    successMessage: t("closeSessionSuccess"),
    errorMessage: t("closeSessionError"),
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
              <CardTitle>{t("openSessionTitle")}</CardTitle>
              <CardDescription>
                {t("openedAt", {
                  date: session.opened_at ? formatDate(session.opened_at) : "—",
                  user: String(session.opened_by_user_id),
                })}
              </CardDescription>
            </div>
            <Badge>{tc("open")}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">{t("openingCash")}</dt>
              <dd className="font-medium">{formatCurrency(session.opening_cash_amount)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("expectedCash")}</dt>
              <dd className="font-medium">{formatCurrency(session.expected_cash_amount)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("expectedDigital")}</dt>
              <dd className="font-medium">{formatCurrency(session.expected_digital_amount)}</dd>
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
          <CardTitle>{t("closeTitle")}</CardTitle>
          <CardDescription>{t("closeSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 max-w-md" onSubmit={handleClose}>
            <div className="grid gap-2">
              <Label htmlFor="counted-amount">{t("countedCash")}</Label>
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
              <Label htmlFor="closing-notes">{tc("notesOptional")}</Label>
              <Input
                id="closing-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("closeNotesPlaceholder")}
              />
            </div>
            <Button type="submit" variant="destructive" disabled={closeMutation.isPending}>
              {closeMutation.isPending ? (
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {t("closeSession")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("movementsTitle")}</CardTitle>
          <CardDescription>{t("movementsSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("movementsEmpty")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
