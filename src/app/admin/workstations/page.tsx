"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MonitorIcon, PlusCircleIcon, ArchiveIcon } from "lucide-react";
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

type Kind = "tattoo" | "piercing" | "general";

const KINDS: Kind[] = ["tattoo", "piercing", "general"];

function readLocationCookie(): number | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/jeff_active_location_id=(\d+)/);
  return m ? Number(m[1]) : null;
}

export default function WorkstationsPage() {
  const t = useTranslations("workstations");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const [activeLocationId, setActiveLocationId] = useState<number | null>(null);
  useEffect(() => setActiveLocationId(readLocationCookie()), []);

  const tKind = (k: Kind) => t(`kinds.${k}`);

  const locationsQuery = useQuery(trpc.locations.list.queryOptions());
  const listInput = useMemo(
    () => ({ locationId: activeLocationId ?? undefined }),
    [activeLocationId],
  );
  const listQuery = useQuery({
    ...trpc.workstations.list.queryOptions(listInput),
    enabled: activeLocationId != null,
  });
  const listKey = trpc.workstations.list.queryOptions(listInput).queryKey;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("tattoo");

  const createMutation = useCrudMutation({
    mutationOptions: trpc.workstations.create.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: t("created"),
    errorMessage: t("createFailed"),
    onSuccess: () => {
      setName("");
      setKind("tattoo");
      setDialogOpen(false);
    },
  });
  const archiveMutation = useCrudMutation({
    mutationOptions: trpc.workstations.archive.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: t("archived"),
    errorMessage: t("archiveFailed"),
  });

  const submit = () => {
    if (!activeLocationId || !name.trim()) return;
    createMutation.mutate({
      locationId: activeLocationId,
      name: name.trim(),
      kind,
    });
  };

  const locations = locationsQuery.data ?? [];
  const stations = listQuery.data ?? [];
  const activeLocationName =
    locations.find((l) => l.id === activeLocationId)?.name ?? "—";

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
          <MonitorIcon className="w-5 h-5" />
          <CardTitle>{t("titleAt", { location: activeLocationName })}</CardTitle>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <PlusCircleIcon className="w-4 h-4 mr-2" /> {t("newWorkstation")}
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colName")}</TableHead>
              <TableHead>{t("colKind")}</TableHead>
              <TableHead className="text-right">{t("colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stations.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="font-medium">{w.name}</TableCell>
                <TableCell>{tKind(w.kind as Kind)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => archiveMutation.mutate({ id: w.id })}
                    disabled={archiveMutation.isPending}
                  >
                    <ArchiveIcon className="w-4 h-4 mr-2" /> {tc("archive")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {stations.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="text-center text-muted-foreground"
                >
                  {t("empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("newWorkstationTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>{t("nameLabel")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("kindLabel")}</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {tKind(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
