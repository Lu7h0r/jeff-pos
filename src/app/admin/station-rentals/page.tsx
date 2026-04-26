"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ClockIcon,
  PlusCircleIcon,
  CheckCircle2Icon,
  XCircleIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTRPC } from "@/lib/trpc/client";
import { useCrudMutation } from "@/hooks/use-crud-mutation";
import { formatCurrency } from "@/lib/utils";

type FormState = {
  workstationId: string;
  staffMemberId: string;
  startAt: string;
  endAt: string;
  amount: string;
  paymentMethodId: string;
  cashSessionId: string;
  notes: string;
};

const EMPTY: FormState = {
  workstationId: "",
  staffMemberId: "",
  startAt: "",
  endAt: "",
  amount: "",
  paymentMethodId: "",
  cashSessionId: "",
  notes: "",
};

function readLocationCookie(): number | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/jeff_active_location_id=(\d+)/);
  return m ? Number(m[1]) : null;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function StationRentalsPage() {
  const t = useTranslations("stationRentals");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const [activeLocationId, setActiveLocationId] = useState<number | null>(null);
  useEffect(() => setActiveLocationId(readLocationCookie()), []);

  const listInput = useMemo(
    () => ({ locationId: activeLocationId ?? undefined }),
    [activeLocationId],
  );
  const listQuery = useQuery({
    ...trpc.stationRentals.list.queryOptions(listInput),
    enabled: activeLocationId != null,
  });
  const listKey = trpc.stationRentals.list.queryOptions(listInput).queryKey;

  const wsInput = useMemo(
    () => ({ locationId: activeLocationId ?? undefined }),
    [activeLocationId],
  );
  const workstationsQuery = useQuery({
    ...trpc.workstations.list.queryOptions(wsInput),
    enabled: activeLocationId != null,
  });
  const staffQuery = useQuery(trpc.staff.list.queryOptions());
  const paymentMethodsQuery = useQuery(trpc.paymentMethods.list.queryOptions());

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);

  const statusLabel = (s: string) =>
    s === "completed"
      ? t("statusCompleted")
      : s === "cancelled"
        ? t("statusCancelled")
        : t("statusScheduled");

  const createMutation = useCrudMutation({
    mutationOptions: trpc.stationRentals.create.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: t("created"),
    errorMessage: t("createFailed"),
    onSuccess: () => {
      setForm(EMPTY);
      setDialogOpen(false);
    },
  });
  const completeMutation = useCrudMutation({
    mutationOptions: trpc.stationRentals.markCompleted.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: t("completed"),
    errorMessage: t("completeFailed"),
  });
  const cancelMutation = useCrudMutation({
    mutationOptions: trpc.stationRentals.cancel.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: t("cancelled"),
    errorMessage: t("cancelFailed"),
  });

  const submit = () => {
    if (
      !form.workstationId ||
      !form.staffMemberId ||
      !form.startAt ||
      !form.endAt ||
      !form.amount
    )
      return;
    createMutation.mutate({
      workstationId: Number(form.workstationId),
      staffMemberId: Number(form.staffMemberId),
      startAt: new Date(form.startAt),
      endAt: new Date(form.endAt),
      amount: Math.round(Number(form.amount) * 100),
      paymentMethodId: form.paymentMethodId
        ? Number(form.paymentMethodId)
        : undefined,
      cashSessionId: form.cashSessionId
        ? Number(form.cashSessionId)
        : undefined,
      notes: form.notes.trim() || undefined,
    });
  };

  const rentals = listQuery.data ?? [];
  const workstations = workstationsQuery.data ?? [];
  const staff = staffQuery.data ?? [];
  const paymentMethods = paymentMethodsQuery.data ?? [];

  const grouped = useMemo(() => {
    const map = new Map<string, typeof rentals>();
    for (const r of rentals) {
      const key = dateKey(r.start_at);
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rentals]);

  if (activeLocationId == null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("noActiveLocationTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("noActiveLocationHint")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <ClockIcon className="w-5 h-5" />
          <CardTitle>{t("title")}</CardTitle>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <PlusCircleIcon className="w-4 h-4 mr-2" /> {t("newRental")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {grouped.length === 0 && (
          <p className="text-center text-muted-foreground text-sm">
            {t("empty")}
          </p>
        )}
        {grouped.map(([day, dayRentals]) => (
          <div key={day} className="space-y-2">
            <h3 className="font-semibold text-sm">{day}</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colWorkstation")}</TableHead>
                  <TableHead>{t("colStaff")}</TableHead>
                  <TableHead>{t("colStart")}</TableHead>
                  <TableHead>{t("colEnd")}</TableHead>
                  <TableHead>{t("colAmount")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead className="text-right">{t("colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dayRentals.map((r) => {
                  const ws = workstations.find(
                    (w) => w.id === r.workstation_id,
                  );
                  const st = staff.find((s) => s.id === r.staff_member_id);
                  return (
                    <TableRow key={r.id}>
                      <TableCell>{ws?.name ?? `#${r.workstation_id}`}</TableCell>
                      <TableCell>
                        {st?.display_name ?? `#${r.staff_member_id}`}
                      </TableCell>
                      <TableCell>
                        {r.start_at.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                      </TableCell>
                      <TableCell>
                        {r.end_at.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                      </TableCell>
                      <TableCell>{formatCurrency(r.amount)}</TableCell>
                      <TableCell>{statusLabel(r.status)}</TableCell>
                      <TableCell className="text-right space-x-1">
                        {r.status === "scheduled" ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                completeMutation.mutate({ id: r.id })
                              }
                              disabled={completeMutation.isPending}
                            >
                              <CheckCircle2Icon className="w-4 h-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => cancelMutation.mutate({ id: r.id })}
                              disabled={cancelMutation.isPending}
                            >
                              <XCircleIcon className="w-4 h-4" />
                            </Button>
                          </>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ))}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("newRentalTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>{t("workstationLabel")}</Label>
              <Select
                value={form.workstationId}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, workstationId: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("pickWorkstation")} />
                </SelectTrigger>
                <SelectContent>
                  {workstations.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name} ({w.kind})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("staffLabel")}</Label>
              <Select
                value={form.staffMemberId}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, staffMemberId: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("pickStaff")} />
                </SelectTrigger>
                <SelectContent>
                  {staff.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>{t("startLabel")}</Label>
                <Input
                  type="datetime-local"
                  value={form.startAt}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, startAt: e.target.value }))
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("endLabel")}</Label>
                <Input
                  type="datetime-local"
                  value={form.endAt}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, endAt: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>{t("amountLabel")}</Label>
              <Input
                type="number"
                min={0}
                value={form.amount}
                onChange={(e) =>
                  setForm((s) => ({ ...s, amount: e.target.value }))
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>{t("paymentMethodOptional")}</Label>
                <Select
                  value={form.paymentMethodId}
                  onValueChange={(v) =>
                    setForm((s) => ({ ...s, paymentMethodId: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {paymentMethods.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>{t("cashSessionId")}</Label>
                <Input
                  value={form.cashSessionId}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, cashSessionId: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>{t("notesLabel")}</Label>
              <Input
                value={form.notes}
                onChange={(e) =>
                  setForm((s) => ({ ...s, notes: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button onClick={submit} disabled={createMutation.isPending}>
              {tc("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
