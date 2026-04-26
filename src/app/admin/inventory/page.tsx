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
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useTRPC } from "@/lib/trpc/client";
import { useCrudMutation } from "@/hooks/use-crud-mutation";
import type { RouterOutputs } from "@/lib/trpc/router";

type BalanceRow = RouterOutputs["inventory"]["balancesByLocation"][number];

function readActiveLocationCookie(): number | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/jeff_active_location_id=(\d+)/);
  return match ? Number(match[1]) : null;
}

export default function InventoryPage() {
  const [locationId, setLocationId] = useState<number | null>(null);

  useEffect(() => {
    setLocationId(readActiveLocationCookie());
  }, []);

  if (locationId === null) {
    return <NoLocationSelected />;
  }

  return <InventoryForLocation locationId={locationId} />;
}

function NoLocationSelected() {
  const t = useTranslations("inventory");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("selectLocation")}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{t("selectLocationHint")}</p>
      </CardContent>
    </Card>
  );
}

function InventoryForLocation({ locationId }: { locationId: number }) {
  const t = useTranslations("inventory");
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const balancesOptions = trpc.inventory.balancesByLocation.queryOptions({
    locationId,
  });
  const { data: balances, isLoading } = useQuery(balancesOptions);

  const activeOptions = trpc.locations.getActive.queryOptions({ locationId });
  const { data: activeLocation } = useQuery(activeOptions);

  const allLocationsOptions = trpc.locations.list.queryOptions();
  const { data: allLocations } = useQuery(allLocationsOptions);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: balancesOptions.queryKey });

  const [adjustTarget, setAdjustTarget] = useState<BalanceRow | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  const otherLocations = (allLocations ?? []).filter(
    (loc) => loc.id !== locationId,
  );

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>
              {t("activeLocation", { name: activeLocation?.name ?? "—" })}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            disabled={otherLocations.length === 0}
            onClick={() => setTransferOpen(true)}
          >
            {t("transferToOther")}
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (balances ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noBalances")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colSku")}</TableHead>
                  <TableHead>{t("colProduct")}</TableHead>
                  <TableHead className="text-right">{t("colOnHand")}</TableHead>
                  <TableHead className="text-right">{t("colReserved")}</TableHead>
                  <TableHead className="text-right">{t("colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(balances ?? []).map((row) => (
                  <TableRow key={row.product_id}>
                    <TableCell className="font-mono text-xs">
                      {row.sku ?? "—"}
                    </TableCell>
                    <TableCell>{row.product_name}</TableCell>
                    <TableCell className="text-right">
                      {row.quantity_on_hand}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.quantity_reserved}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAdjustTarget(row)}
                      >
                        {t("adjust")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {adjustTarget ? (
        <AdjustDialog
          row={adjustTarget}
          locationId={locationId}
          onClose={() => setAdjustTarget(null)}
          onSuccess={() => {
            setAdjustTarget(null);
            invalidate();
          }}
        />
      ) : null}

      {transferOpen ? (
        <TransferDialog
          locationId={locationId}
          balances={balances ?? []}
          targets={otherLocations}
          onClose={() => setTransferOpen(false)}
          onSuccess={() => {
            setTransferOpen(false);
            invalidate();
          }}
        />
      ) : null}
    </div>
  );
}

interface AdjustDialogProps {
  row: BalanceRow;
  locationId: number;
  onClose: () => void;
  onSuccess: () => void;
}

function AdjustDialog({ row, locationId, onClose, onSuccess }: AdjustDialogProps) {
  const t = useTranslations("inventory");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const [delta, setDelta] = useState<string>("0");
  const [type, setType] = useState<"adjustment" | "internal_consumption">(
    "adjustment",
  );
  const [notes, setNotes] = useState<string>("");

  const adjustMutation = useCrudMutation({
    mutationOptions: trpc.inventory.adjust.mutationOptions(),
    invalidateKeys: trpc.inventory.balancesByLocation.queryOptions({ locationId })
      .queryKey,
    successMessage: t("adjusted"),
    errorMessage: t("adjustFailed"),
    onSuccess: () => {
      onSuccess();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = Number(delta);
    if (!Number.isInteger(value) || value === 0) return;
    adjustMutation.mutate({
      productId: row.product_id,
      locationId,
      quantityDelta: value,
      type,
      notes: notes.trim() ? notes.trim() : undefined,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("adjustTitle", { product: row.product_name })}</DialogTitle>
          <DialogDescription>
            {t("adjustSubtitle", { onHand: row.quantity_on_hand })}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="adjust-delta">{t("deltaLabel")}</Label>
            <Input
              id="adjust-delta"
              type="number"
              step="1"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="adjust-type">{t("typeLabel")}</Label>
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
              <SelectTrigger id="adjust-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="adjustment">{t("typeAdjustment")}</SelectItem>
                <SelectItem value="internal_consumption">
                  {t("typeInternal")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="adjust-notes">{tc("notesOptional")}</Label>
            <Input
              id="adjust-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={adjustMutation.isPending}>
              {adjustMutation.isPending ? (
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {tc("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface TransferDialogProps {
  locationId: number;
  balances: BalanceRow[];
  targets: { id: number; name: string }[];
  onClose: () => void;
  onSuccess: () => void;
}

function TransferDialog({
  locationId,
  balances,
  targets,
  onClose,
  onSuccess,
}: TransferDialogProps) {
  const t = useTranslations("inventory");
  const tc = useTranslations("common");
  const trpc = useTRPC();
  const [productId, setProductId] = useState<string>(
    balances[0] ? String(balances[0].product_id) : "",
  );
  const [toLocationId, setToLocationId] = useState<string>(
    targets[0] ? String(targets[0].id) : "",
  );
  const [quantity, setQuantity] = useState<string>("1");
  const [notes, setNotes] = useState<string>("");

  const transferMutation = useCrudMutation({
    mutationOptions: trpc.inventory.transfer.mutationOptions(),
    invalidateKeys: trpc.inventory.balancesByLocation.queryOptions({ locationId })
      .queryKey,
    successMessage: t("transferred"),
    errorMessage: t("transferFailed"),
    onSuccess: () => {
      onSuccess();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const pid = Number(productId);
    const toId = Number(toLocationId);
    const qty = Number(quantity);
    if (!Number.isInteger(pid) || !Number.isInteger(toId) || !Number.isInteger(qty) || qty <= 0) {
      return;
    }
    transferMutation.mutate({
      productId: pid,
      fromLocationId: locationId,
      toLocationId: toId,
      quantity: qty,
      notes: notes.trim() ? notes.trim() : undefined,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("transferTitle")}</DialogTitle>
          <DialogDescription>{t("transferSubtitle")}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="transfer-product">{t("transferProductLabel")}</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger id="transfer-product">
                <SelectValue placeholder={t("pickProduct")} />
              </SelectTrigger>
              <SelectContent>
                {balances.map((row) => (
                  <SelectItem key={row.product_id} value={String(row.product_id)}>
                    {t("productOnHand", { name: row.product_name, onHand: row.quantity_on_hand })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="transfer-target">{t("transferTargetLabel")}</Label>
            <Select value={toLocationId} onValueChange={setToLocationId}>
              <SelectTrigger id="transfer-target">
                <SelectValue placeholder={t("pickTarget")} />
              </SelectTrigger>
              <SelectContent>
                {targets.map((loc) => (
                  <SelectItem key={loc.id} value={String(loc.id)}>
                    {loc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="transfer-quantity">{t("transferQty")}</Label>
            <Input
              id="transfer-quantity"
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="transfer-notes">{tc("notesOptional")}</Label>
            <Input
              id="transfer-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={transferMutation.isPending || balances.length === 0 || targets.length === 0}
            >
              {transferMutation.isPending ? (
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {t("transferAction")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
