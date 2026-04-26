"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserIcon, PlusCircleIcon, ArchiveIcon, CheckIcon } from "lucide-react";
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

type Kind = "artist" | "apprentice" | "piercer" | "manager" | "external";
type Split =
  | "staff_30_house_70"
  | "staff_50_house_50"
  | "staff_70_house_30"
  | "owner_direct"
  | "manual";

type FormState = {
  displayName: string;
  kind: Kind;
  commissionRatePct: string;
  defaultSplit: Split;
  userId: string;
  notes: string;
};

const EMPTY: FormState = {
  displayName: "",
  kind: "artist",
  commissionRatePct: "30",
  defaultSplit: "staff_30_house_70",
  userId: "",
  notes: "",
};

const KIND_OPTIONS: Kind[] = [
  "artist",
  "apprentice",
  "piercer",
  "manager",
  "external",
];
const SPLIT_OPTIONS: Split[] = [
  "staff_30_house_70",
  "staff_50_house_50",
  "staff_70_house_30",
  "owner_direct",
  "manual",
];

export default function StaffPage() {
  const t = useTranslations("staff");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const listQuery = useQuery(trpc.staff.list.queryOptions());
  const listKey = trpc.staff.list.queryOptions().queryKey;
  const commissionsQuery = useQuery(
    trpc.services.commissions.list.queryOptions({}),
  );
  const commissionsKey = trpc.services.commissions.list.queryOptions(
    {},
  ).queryKey;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);

  const tKind = (k: Kind) => t(`kinds.${k}`);
  const tSplit = (s: Split) => t(`splits.${s}`);

  const createMutation = useCrudMutation({
    mutationOptions: trpc.staff.create.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: t("created"),
    errorMessage: t("createFailed"),
    onSuccess: () => {
      setForm(EMPTY);
      setDialogOpen(false);
    },
  });
  const archiveMutation = useCrudMutation({
    mutationOptions: trpc.staff.archive.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: t("archived"),
    errorMessage: t("archiveFailed"),
  });
  const liquidateMutation = useCrudMutation({
    mutationOptions: trpc.services.commissions.markLiquidated.mutationOptions(),
    invalidateKeys: commissionsKey,
    successMessage: t("liquidated"),
    errorMessage: t("liquidateFailed"),
  });

  const submit = () => {
    if (!form.displayName.trim()) return;
    const pct = Math.max(0, Math.min(100, Number(form.commissionRatePct) || 0));
    createMutation.mutate({
      displayName: form.displayName.trim(),
      kind: form.kind,
      commissionRate: Math.round(pct * 100),
      defaultSplit: form.defaultSplit,
      userId: form.userId.trim() || undefined,
      notes: form.notes.trim() || undefined,
    });
  };

  const staff = listQuery.data ?? [];
  const commissions = commissionsQuery.data ?? [];

  const totals = useMemo(() => {
    const map = new Map<number, number>();
    for (const c of commissions) {
      if (c.status === "estimated" || c.status === "manual_pending") {
        map.set(
          c.staff_member_id,
          (map.get(c.staff_member_id) ?? 0) + c.staff_share_amount,
        );
      }
    }
    return map;
  }, [commissions]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <UserIcon className="w-5 h-5" />
            <CardTitle>{t("title")}</CardTitle>
          </div>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <PlusCircleIcon className="w-4 h-4 mr-2" /> {t("newStaff")}
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colKind")}</TableHead>
                <TableHead>{t("colCommission")}</TableHead>
                <TableHead>{t("colSplit")}</TableHead>
                <TableHead>{t("colPending")}</TableHead>
                <TableHead className="text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.display_name}</TableCell>
                  <TableCell>{tKind(s.kind as Kind)}</TableCell>
                  <TableCell>{(s.commission_rate / 100).toFixed(2)}%</TableCell>
                  <TableCell>{tSplit(s.default_split as Split)}</TableCell>
                  <TableCell>
                    {formatCurrency(totals.get(s.id) ?? 0)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => archiveMutation.mutate({ id: s.id })}
                      disabled={archiveMutation.isPending}
                    >
                      <ArchiveIcon className="w-4 h-4 mr-2" /> {tc("archive")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {staff.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    {t("empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("commissionsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colStaff")}</TableHead>
                <TableHead>{t("colGross")}</TableHead>
                <TableHead>{t("colStaffShare")}</TableHead>
                <TableHead>{t("colHouseShare")}</TableHead>
                <TableHead>{t("colSplitKind")}</TableHead>
                <TableHead>{t("colCommissionStatus")}</TableHead>
                <TableHead className="text-right">{t("colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {commissions.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.staff_display_name}</TableCell>
                  <TableCell>{formatCurrency(c.gross_amount)}</TableCell>
                  <TableCell>{formatCurrency(c.staff_share_amount)}</TableCell>
                  <TableCell>{formatCurrency(c.house_share_amount)}</TableCell>
                  <TableCell>{tSplit(c.split_kind as Split)}</TableCell>
                  <TableCell>{c.status}</TableCell>
                  <TableCell className="text-right">
                    {c.status !== "liquidated" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          liquidateMutation.mutate({
                            commissionEstimateId: c.id,
                          })
                        }
                        disabled={liquidateMutation.isPending}
                      >
                        <CheckIcon className="w-4 h-4 mr-2" /> {t("markLiquidated")}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {commissions.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground"
                  >
                    {t("noCommissions")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("newStaffTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>{t("displayNameLabel")}</Label>
              <Input
                value={form.displayName}
                onChange={(e) =>
                  setForm((s) => ({ ...s, displayName: e.target.value }))
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>{t("kindLabel")}</Label>
                <Select
                  value={form.kind}
                  onValueChange={(v) =>
                    setForm((s) => ({ ...s, kind: v as Kind }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KIND_OPTIONS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {tKind(k)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>{t("commissionRateLabel")}</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.commissionRatePct}
                  onChange={(e) =>
                    setForm((s) => ({
                      ...s,
                      commissionRatePct: e.target.value,
                    }))
                  }
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>{t("defaultSplitLabel")}</Label>
              <Select
                value={form.defaultSplit}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, defaultSplit: v as Split }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPLIT_OPTIONS.map((sp) => (
                    <SelectItem key={sp} value={sp}>
                      {tSplit(sp)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("userIdLabel")}</Label>
              <Input
                value={form.userId}
                onChange={(e) =>
                  setForm((s) => ({ ...s, userId: e.target.value }))
                }
                placeholder={t("userIdPlaceholder")}
              />
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
    </div>
  );
}
