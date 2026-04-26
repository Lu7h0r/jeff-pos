"use client";

import React, { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Combobox } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Loader2Icon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import Link from "next/link";
import { useTRPC } from "@/lib/trpc/client";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ACTIVE_LOCATION_COOKIE = "jeff_active_location_id";

type ServiceKind =
  | "tattoo"
  | "piercing"
  | "touchup"
  | "removal"
  | "consultation"
  | "other";

// Per-cart-line service attachment intent. Resolved AFTER orders.create
// succeeds: we map each created order_item back to its productId and call
// services.attachToOrderItem. This is post-sale enrichment and never blocks
// the POS confirm flow — failure to attach surfaces as a toast, never as a
// rolled-back sale.
type ServiceIntent = {
  staffMemberId: number;
  serviceKind: ServiceKind;
  bodyLocation?: string;
};

type CartItem = {
  productId: number;
  name: string;
  unitPrice: number;
  onHand: number;
  quantity: number;
  service?: ServiceIntent;
};

const SERVICE_KINDS: ServiceKind[] = [
  "tattoo",
  "piercing",
  "touchup",
  "removal",
  "consultation",
  "other",
];

type PaymentLine = {
  paymentMethodId: number | null;
  amount: number;
};

function readLocationCookie(): number | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${ACTIVE_LOCATION_COOKIE}=`));
  if (!match) return null;
  const value = Number(match.split("=")[1]);
  return Number.isFinite(value) ? value : null;
}

export default function POSPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locationId = useMemo(() => readLocationCookie(), []);

  // Cash session is the gate. If null, the POS is locked behind a hint.
  const sessionQuery = useQuery({
    ...trpc.cashSessions.current.queryOptions({ locationId: locationId ?? 0 }),
    enabled: locationId != null,
  });

  const balancesQuery = useQuery({
    ...trpc.inventory.balancesByLocation.queryOptions({
      locationId: locationId ?? 0,
    }),
    enabled: locationId != null && sessionQuery.data != null,
  });

  const customersQuery = useQuery(trpc.customers.list.queryOptions());
  const paymentMethodsQuery = useQuery(trpc.paymentMethods.list.queryOptions());
  const staffQuery = useQuery(trpc.staff.list.queryOptions());

  const attachServiceMutation = useMutation(
    trpc.services.attachToOrderItem.mutationOptions(),
  );

  const createOrderMutation = useMutation(
    trpc.orders.create.mutationOptions({
      onSuccess: async (order) => {
        queryClient.invalidateQueries(trpc.orders.list.queryOptions());
        queryClient.invalidateQueries(
          trpc.inventory.balancesByLocation.queryOptions({
            locationId: locationId ?? 0,
          }),
        );
        queryClient.invalidateQueries(
          trpc.cashSessions.current.queryOptions({
            locationId: locationId ?? 0,
          }),
        );
        toast.success(
          `Order #${order.id} created — total $${(order.total_amount / 100).toFixed(2)}`,
        );

        // Post-sale service attachment. Done after orders.create succeeds so
        // the POS confirm path stays atomic and unbroken; attach failures
        // surface as toasts and never roll back the sale.
        const intents = cart
          .map((c) => {
            if (!c.service) return null;
            const orderItem = order.items.find(
              (it) => it.product_id === c.productId,
            );
            if (!orderItem) return null;
            return {
              orderItemId: orderItem.id,
              ...c.service,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null);

        for (const intent of intents) {
          try {
            await attachServiceMutation.mutateAsync({
              orderItemId: intent.orderItemId,
              staffMemberId: intent.staffMemberId,
              serviceKind: intent.serviceKind,
              bodyLocation: intent.bodyLocation || undefined,
            });
          } catch (e) {
            toast.error(
              `Service attach failed for item ${intent.orderItemId}: ${
                e instanceof Error ? e.message : "unknown error"
              }`,
            );
          }
        }

        setCart([]);
        setSelectedCustomerId(null);
        setPaymentLines([{ paymentMethodId: null, amount: 0 }]);
      },
      onError: (err) => toast.error(err.message || "Failed to create order"),
    }),
  );

  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(
    null,
  );
  const [productSearch, setProductSearch] = useState("");
  const [paymentLines, setPaymentLines] = useState<PaymentLine[]>([
    { paymentMethodId: null, amount: 0 },
  ]);

  const [serviceDialogProductId, setServiceDialogProductId] = useState<
    number | null
  >(null);
  const [serviceForm, setServiceForm] = useState<{
    staffMemberId: string;
    serviceKind: ServiceKind;
    bodyLocation: string;
  }>({ staffMemberId: "", serviceKind: "tattoo", bodyLocation: "" });

  const balances = balancesQuery.data ?? [];
  const filteredBalances = useMemo(() => {
    const inStock = balances.filter((b) => b.quantity_on_hand > 0);
    if (!productSearch.trim()) return inStock;
    const q = productSearch.toLowerCase();
    return inStock.filter(
      (b) =>
        b.product_name.toLowerCase().includes(q) ||
        (b.sku ?? "").toLowerCase().includes(q),
    );
  }, [balances, productSearch]);

  const total = cart.reduce((sum, c) => sum + c.unitPrice * c.quantity, 0);
  const paymentsTotal = paymentLines.reduce(
    (sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0),
    0,
  );
  const paymentsMatch = paymentsTotal === total && total > 0;
  const allPaymentsAssigned = paymentLines.every(
    (p) => p.paymentMethodId != null && p.amount > 0,
  );
  const canCreate =
    cart.length > 0 &&
    paymentLines.length > 0 &&
    paymentsMatch &&
    allPaymentsAssigned;

  const handleAddProduct = (productId: number | string) => {
    const balance = balances.find((b) => b.product_id === Number(productId));
    if (!balance) return;
    if (balance.quantity_on_hand <= 0) {
      toast.error(`${balance.product_name} is out of stock`);
      return;
    }
    setCart((prev) => {
      const existing = prev.find((c) => c.productId === balance.product_id);
      if (existing) {
        if (existing.quantity >= balance.quantity_on_hand) {
          toast.error(`Only ${balance.quantity_on_hand} units available`);
          return prev;
        }
        return prev.map((c) =>
          c.productId === balance.product_id
            ? { ...c, quantity: c.quantity + 1 }
            : c,
        );
      }
      // unitPrice is read at create time from the DB; we still cache it
      // here for the cart total preview. The server recomputes from DB.
      return [
        ...prev,
        {
          productId: balance.product_id,
          name: balance.product_name,
          unitPrice: 0,
          onHand: balance.quantity_on_hand,
          quantity: 1,
        },
      ];
    });
  };

  const handleQuantityChange = (productId: number, delta: number) => {
    setCart((prev) =>
      prev.map((c) => {
        if (c.productId !== productId) return c;
        const next = c.quantity + delta;
        if (next <= 0) return c;
        if (next > c.onHand) {
          toast.error(`Only ${c.onHand} units available`);
          return c;
        }
        return { ...c, quantity: next };
      }),
    );
  };

  const handleRemove = (productId: number) =>
    setCart((prev) => prev.filter((c) => c.productId !== productId));

  const openServiceDialog = (productId: number) => {
    const existing = cart.find((c) => c.productId === productId)?.service;
    setServiceForm({
      staffMemberId: existing ? String(existing.staffMemberId) : "",
      serviceKind: existing?.serviceKind ?? "tattoo",
      bodyLocation: existing?.bodyLocation ?? "",
    });
    setServiceDialogProductId(productId);
  };

  const saveServiceIntent = () => {
    if (serviceDialogProductId == null) return;
    if (!serviceForm.staffMemberId) {
      toast.error("Pick a staff member");
      return;
    }
    setCart((prev) =>
      prev.map((c) =>
        c.productId === serviceDialogProductId
          ? {
              ...c,
              service: {
                staffMemberId: Number(serviceForm.staffMemberId),
                serviceKind: serviceForm.serviceKind,
                bodyLocation: serviceForm.bodyLocation.trim() || undefined,
              },
            }
          : c,
      ),
    );
    setServiceDialogProductId(null);
  };

  const updatePaymentLine = (index: number, patch: Partial<PaymentLine>) =>
    setPaymentLines((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );

  const removePaymentLine = (index: number) =>
    setPaymentLines((prev) => prev.filter((_, i) => i !== index));

  const addPaymentLine = () =>
    setPaymentLines((prev) => [
      ...prev,
      { paymentMethodId: null, amount: 0 },
    ]);

  const handleCreate = () => {
    if (!canCreate) return;
    createOrderMutation.mutate({
      locationId: locationId!,
      customerId: selectedCustomerId ?? undefined,
      items: cart.map((c) => ({
        productId: c.productId,
        quantity: c.quantity,
      })),
      paymentLines: paymentLines.map((p) => ({
        paymentMethodId: p.paymentMethodId!,
        amount: p.amount,
      })),
    });
  };

  if (locationId == null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>POS unavailable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            No active location. Pick a location in the top bar before opening
            the POS.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (sessionQuery.isLoading) {
    return (
      <div className="container mx-auto p-4 space-y-4">
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!sessionQuery.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No open cash session</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You cannot create a sale without an open cash session at this
            location. Open one in the cashier page first.
          </p>
          <Link
            href="/admin/cashier"
            className="inline-flex items-center text-primary underline"
          >
            Go to cashier
          </Link>
        </CardContent>
      </Card>
    );
  }

  const customers = customersQuery.data ?? [];
  const paymentMethods = paymentMethodsQuery.data ?? [];

  return (
    <div className="w-full max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Catalogue (in-stock)</CardTitle>
          <div className="relative !mt-4">
            <SearchIcon className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by name or SKU"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardHeader>
        <CardContent>
          <Combobox
            items={filteredBalances.map((b) => ({
              id: b.product_id,
              name: `${b.product_name} (${b.quantity_on_hand} on hand)`,
            }))}
            placeholder="Add to cart"
            noSelect
            onSelect={handleAddProduct}
          />
          <div className="mt-3 max-h-72 overflow-y-auto text-sm">
            {filteredBalances.length === 0 ? (
              <p className="text-muted-foreground">No products in stock.</p>
            ) : (
              <ul className="space-y-1">
                {filteredBalances.map((b) => (
                  <li
                    key={b.product_id}
                    className="flex justify-between border-b py-1"
                  >
                    <span>{b.product_name}</span>
                    <Badge
                      variant={b.quantity_on_hand > 5 ? "default" : "destructive"}
                    >
                      {b.quantity_on_hand}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Cart</CardTitle>
            <div className="!mt-4">
              <Combobox
                items={customers}
                placeholder="Walk-in (no customer)"
                onSelect={(id) => setSelectedCustomerId(Number(id))}
              />
            </div>
          </CardHeader>
          <CardContent>
            {cart.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Add a product from the catalogue.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Qty</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cart.map((c) => (
                    <TableRow key={c.productId}>
                      <TableCell>{c.name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-7 w-7"
                            onClick={() =>
                              handleQuantityChange(c.productId, -1)
                            }
                            disabled={c.quantity <= 1}
                          >
                            <MinusIcon className="h-3 w-3" />
                          </Button>
                          <span className="w-8 text-center">{c.quantity}</span>
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-7 w-7"
                            onClick={() => handleQuantityChange(c.productId, 1)}
                            disabled={c.quantity >= c.onHand}
                          >
                            <PlusIcon className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant={c.service ? "default" : "outline"}
                            size="sm"
                            onClick={() => openServiceDialog(c.productId)}
                            title={
                              c.service
                                ? "Service attached — click to edit"
                                : "Attach service performer"
                            }
                          >
                            <UserIcon className="h-3 w-3 mr-1" />
                            {c.service ? "Servicio" : "+ Servicio"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemove(c.productId)}
                          >
                            <Trash2Icon className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Server recomputes prices from the DB at sale time.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment</CardTitle>
            <p className="text-xs text-muted-foreground !mt-2">
              Sum of payments must match the cart total before confirming.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {paymentLines.map((line, index) => (
              <div key={index} className="flex items-center gap-2">
                <div className="flex-1">
                  <Combobox
                    items={paymentMethods}
                    placeholder="Method"
                    onSelect={(id) =>
                      updatePaymentLine(index, {
                        paymentMethodId: Number(id),
                      })
                    }
                  />
                </div>
                <Input
                  type="number"
                  min={0}
                  className="w-32"
                  value={line.amount === 0 ? "" : line.amount}
                  onChange={(e) =>
                    updatePaymentLine(index, {
                      amount: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                    })
                  }
                  placeholder="0"
                />
                {paymentLines.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removePaymentLine(index)}
                  >
                    <Trash2Icon className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addPaymentLine}>
              <PlusIcon className="h-3 w-3 mr-1" /> Add payment method
            </Button>
            <div className="border-t pt-3 flex items-center justify-between">
              <span className="text-sm">Cart total</span>
              <strong>${(total / 100).toFixed(2)}</strong>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">Payments total</span>
              <strong className={paymentsMatch ? "" : "text-destructive"}>
                ${(paymentsTotal / 100).toFixed(2)}
              </strong>
            </div>
            <Button
              size="lg"
              className="w-full"
              disabled={!canCreate || createOrderMutation.isPending}
              onClick={handleCreate}
            >
              {createOrderMutation.isPending ? (
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Confirm sale
            </Button>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={serviceDialogProductId != null}
        onOpenChange={(open) => !open && setServiceDialogProductId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quien realizó este servicio?</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>Staff</Label>
              <Select
                value={serviceForm.staffMemberId}
                onValueChange={(v) =>
                  setServiceForm((s) => ({ ...s, staffMemberId: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a staff member" />
                </SelectTrigger>
                <SelectContent>
                  {(staffQuery.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Service kind</Label>
              <Select
                value={serviceForm.serviceKind}
                onValueChange={(v) =>
                  setServiceForm((s) => ({
                    ...s,
                    serviceKind: v as ServiceKind,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Body location (optional)</Label>
              <Input
                value={serviceForm.bodyLocation}
                onChange={(e) =>
                  setServiceForm((s) => ({
                    ...s,
                    bodyLocation: e.target.value,
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setServiceDialogProductId(null)}
            >
              Cancel
            </Button>
            <Button onClick={saveServiceIntent}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
