"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ShoppingBasketIcon,
  PlusCircleIcon,
  CheckCircle2Icon,
  XCircleIcon,
  Trash2Icon,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { useTRPC } from "@/lib/trpc/client";
import { useCrudMutation } from "@/hooks/use-crud-mutation";

type LineItem = { productId: string; quantity: string; unitCost: string };

type FormState = {
  locationId: string;
  supplierId: string;
  paymentMethodId: string;
  cashSessionId: string;
  notes: string;
  items: LineItem[];
};

const EMPTY_LINE: LineItem = { productId: "", quantity: "1", unitCost: "0" };
const EMPTY_FORM: FormState = {
  locationId: "",
  supplierId: "",
  paymentMethodId: "",
  cashSessionId: "",
  notes: "",
  items: [{ ...EMPTY_LINE }],
};

function formatMoney(minor: number) {
  return (minor / 100).toLocaleString("es-CO", {
    style: "currency",
    currency: "COP",
    minimumFractionDigits: 2,
  });
}

function statusVariant(
  status: "draft" | "received" | "cancelled",
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "received") return "default";
  if (status === "cancelled") return "destructive";
  return "secondary";
}

export default function PurchasesPage() {
  const trpc = useTRPC();
  const listQuery = useQuery(trpc.purchases.list.queryOptions({}));
  const productsQuery = useQuery(trpc.products.list.queryOptions());
  const suppliersQuery = useQuery(trpc.suppliers.list.queryOptions());
  const locationsQuery = useQuery(trpc.locations.list.queryOptions());
  const paymentMethodsQuery = useQuery(trpc.paymentMethods.list.queryOptions());

  const listKey = trpc.purchases.list.queryOptions({}).queryKey;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const createMutation = useCrudMutation({
    mutationOptions: trpc.purchases.create.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: "Purchase created",
    errorMessage: "Failed to create purchase",
    onSuccess: () => {
      setForm(EMPTY_FORM);
      setDialogOpen(false);
    },
  });

  const receiveMutation = useCrudMutation({
    mutationOptions: trpc.purchases.receive.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: "Purchase received",
    errorMessage: "Failed to receive purchase",
  });

  const cancelMutation = useCrudMutation({
    mutationOptions: trpc.purchases.cancel.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: "Purchase cancelled",
    errorMessage: "Failed to cancel purchase",
  });

  const updateLine = (idx: number, patch: Partial<LineItem>) => {
    setForm((s) => ({
      ...s,
      items: s.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    }));
  };

  const addLine = () =>
    setForm((s) => ({ ...s, items: [...s.items, { ...EMPTY_LINE }] }));

  const removeLine = (idx: number) =>
    setForm((s) => ({
      ...s,
      items: s.items.filter((_, i) => i !== idx),
    }));

  const submit = () => {
    const items = form.items
      .map((it) => ({
        productId: Number(it.productId),
        quantity: Number(it.quantity),
        unitCost: Math.round(parseFloat(it.unitCost) * 100),
      }))
      .filter(
        (it) =>
          Number.isFinite(it.productId) &&
          it.productId > 0 &&
          it.quantity > 0 &&
          it.unitCost > 0,
      );
    if (!form.locationId || items.length === 0) return;

    createMutation.mutate({
      locationId: Number(form.locationId),
      supplierId: form.supplierId ? Number(form.supplierId) : undefined,
      items,
      paymentMethodId: form.paymentMethodId
        ? Number(form.paymentMethodId)
        : undefined,
      cashSessionId: form.cashSessionId
        ? Number(form.cashSessionId)
        : undefined,
      notes: form.notes.trim() || undefined,
    });
  };

  const orders = listQuery.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <ShoppingBasketIcon className="w-5 h-5" />
          <CardTitle>Purchase orders</CardTitle>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <PlusCircleIcon className="w-4 h-4 mr-2" /> New purchase
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-mono">{o.id}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(o.status)}>{o.status}</Badge>
                </TableCell>
                <TableCell>{o.location_id}</TableCell>
                <TableCell className="text-right">
                  {formatMoney(o.total_amount)}
                </TableCell>
                <TableCell>
                  {o.created_at
                    ? new Date(o.created_at).toLocaleDateString("es-CO")
                    : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {o.status === "draft" && (
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={receiveMutation.isPending}
                        onClick={() =>
                          receiveMutation.mutate({ purchaseOrderId: o.id })
                        }
                      >
                        <CheckCircle2Icon className="w-4 h-4 mr-1" /> Receive
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={cancelMutation.isPending}
                        onClick={() =>
                          cancelMutation.mutate({ purchaseOrderId: o.id })
                        }
                      >
                        <XCircleIcon className="w-4 h-4 mr-1" /> Cancel
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No purchase orders yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New purchase</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>Location</Label>
              <Select
                value={form.locationId}
                onValueChange={(v) => setForm((s) => ({ ...s, locationId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a location" />
                </SelectTrigger>
                <SelectContent>
                  {(locationsQuery.data ?? []).map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Supplier (optional)</Label>
              <Select
                value={form.supplierId}
                onValueChange={(v) => setForm((s) => ({ ...s, supplierId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Walk-in" />
                </SelectTrigger>
                <SelectContent>
                  {(suppliersQuery.data ?? []).map((sup) => (
                    <SelectItem key={sup.id} value={String(sup.id)}>
                      {sup.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Payment method (optional)</Label>
              <Select
                value={form.paymentMethodId}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, paymentMethodId: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {(paymentMethodsQuery.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Cash session id (optional)</Label>
              <Input
                type="number"
                value={form.cashSessionId}
                onChange={(e) =>
                  setForm((s) => ({ ...s, cashSessionId: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>Notes</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm((s) => ({ ...s, notes: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <Label>Items</Label>
              <div className="flex flex-col gap-2">
                {form.items.map((it, idx) => (
                  <div key={idx} className="flex gap-2 items-end">
                    <div className="flex-1">
                      <Select
                        value={it.productId}
                        onValueChange={(v) => updateLine(idx, { productId: v })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Product" />
                        </SelectTrigger>
                        <SelectContent>
                          {(productsQuery.data ?? []).map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      className="w-20"
                      type="number"
                      value={it.quantity}
                      onChange={(e) =>
                        updateLine(idx, { quantity: e.target.value })
                      }
                      placeholder="Qty"
                    />
                    <Input
                      className="w-32"
                      type="number"
                      step="0.01"
                      value={it.unitCost}
                      onChange={(e) =>
                        updateLine(idx, { unitCost: e.target.value })
                      }
                      placeholder="Unit cost"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => removeLine(idx)}
                      disabled={form.items.length === 1}
                    >
                      <Trash2Icon className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                <Button type="button" size="sm" variant="outline" onClick={addLine}>
                  <PlusCircleIcon className="w-4 h-4 mr-2" /> Add item
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={createMutation.isPending}>
              Save draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
