"use client";

import React, { useState, useMemo, useEffect } from "react";
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
  ScissorsIcon,
  SearchIcon,
  Trash2Icon,
  UserIcon,
  PackageIcon,
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

type ProductKind = "product" | "service";

// Per-cart-line service attachment intent. Resolved AFTER orders.create
// succeeds: we map each created order_item back to its productId and call
// services.attachToOrderItem. This is post-sale enrichment and never blocks
// the POS confirm flow — failure to attach surfaces as a toast, never as a
// rolled-back sale.
type ServiceIntent = {
  staffMemberId: number;
  staffDisplayName: string;
  serviceKind: ServiceKind;
  bodyLocation?: string;
};

type CartItem = {
  productId: number;
  name: string;
  unitPrice: number;
  onHand: number;
  quantity: number;
  kind: ProductKind;
  defaultServiceKind: ServiceKind | null;
  service?: ServiceIntent;
};

// Unified catalogue row — covers physical (with on-hand from balances) and
// service (intangible, no on-hand). Built client-side from two queries: the
// inventory balances feed (physical only) plus products.list filtered to
// kind=service. Keeping catalogue assembly in the page keeps the routers
// untouched while still letting the operator search both kinds inline.
type CatalogueItem = {
  productId: number;
  name: string;
  sku: string | null;
  kind: ProductKind;
  defaultServiceKind: ServiceKind | null;
  unitPrice: number;
  onHand: number; // Number.POSITIVE_INFINITY for services
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

  const productsQuery = useQuery({
    ...trpc.products.list.queryOptions(),
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
              staffMemberId: c.service.staffMemberId,
              serviceKind: c.service.serviceKind,
              bodyLocation: c.service.bodyLocation,
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

  // Catalogue assembly: physical products from inventory_balances joined with
  // services from products.list. Services have no on-hand so we plug
  // POSITIVE_INFINITY to keep the cart logic uniform; the server still owns
  // the truth on stock, so a stale cap here can never oversell.
  const catalogue: CatalogueItem[] = useMemo(() => {
    const balances = balancesQuery.data ?? [];
    const allProducts = productsQuery.data ?? [];
    const productById = new Map(allProducts.map((p) => [p.id, p]));

    const physical: CatalogueItem[] = balances
      .filter((b) => b.quantity_on_hand > 0)
      .map((b) => {
        const product = productById.get(b.product_id);
        return {
          productId: b.product_id,
          name: b.product_name,
          sku: b.sku ?? null,
          kind: "product" as ProductKind,
          defaultServiceKind: null,
          unitPrice: product?.price ?? 0,
          onHand: b.quantity_on_hand,
        };
      });

    const services: CatalogueItem[] = allProducts
      .filter((p) => p.kind === "service")
      .map((p) => ({
        productId: p.id,
        name: p.name,
        sku: null,
        kind: "service" as ProductKind,
        defaultServiceKind: (p.default_service_kind ?? null) as ServiceKind | null,
        unitPrice: p.price,
        onHand: Number.POSITIVE_INFINITY,
      }));

    return [...services, ...physical];
  }, [balancesQuery.data, productsQuery.data]);

  const filteredCatalogue = useMemo(() => {
    if (!productSearch.trim()) return catalogue;
    const q = productSearch.toLowerCase();
    return catalogue.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.sku ?? "").toLowerCase().includes(q),
    );
  }, [catalogue, productSearch]);

  const groupedCatalogue = useMemo(() => {
    return {
      services: filteredCatalogue.filter((c) => c.kind === "service"),
      products: filteredCatalogue.filter((c) => c.kind === "product"),
    };
  }, [filteredCatalogue]);

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

  const unassignedServiceCount = cart.filter(
    (c) => c.kind === "service" && !c.service,
  ).length;

  const handleAddCatalogueItem = (productId: number) => {
    const item = catalogue.find((c) => c.productId === productId);
    if (!item) return;
    if (item.onHand <= 0) {
      toast.error(`${item.name} is out of stock`);
      return;
    }
    setCart((prev) => {
      const existing = prev.find((c) => c.productId === item.productId);
      if (existing) {
        if (existing.quantity >= item.onHand) {
          toast.error(`Only ${item.onHand} units available`);
          return prev;
        }
        return prev.map((c) =>
          c.productId === item.productId
            ? { ...c, quantity: c.quantity + 1 }
            : c,
        );
      }
      return [
        ...prev,
        {
          productId: item.productId,
          name: item.name,
          unitPrice: item.unitPrice,
          onHand: item.onHand,
          quantity: 1,
          kind: item.kind,
          defaultServiceKind: item.defaultServiceKind,
        },
      ];
    });

    // Auto-open the attach dialog for service items so the operator does not
    // have to hunt for a small button. The dialog can be dismissed and filled
    // later from admin/orders if needed.
    if (item.kind === "service") {
      openServiceDialog(item.productId);
    }
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
    const cartItem = cart.find((c) => c.productId === productId);
    const catalogueItem = catalogue.find((c) => c.productId === productId);
    const existing = cartItem?.service;
    const fallbackKind: ServiceKind =
      catalogueItem?.defaultServiceKind ?? "tattoo";
    setServiceForm({
      staffMemberId: existing ? String(existing.staffMemberId) : "",
      serviceKind: existing?.serviceKind ?? fallbackKind,
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
    const staffId = Number(serviceForm.staffMemberId);
    const staff = (staffQuery.data ?? []).find((s) => s.id === staffId);
    setCart((prev) =>
      prev.map((c) =>
        c.productId === serviceDialogProductId
          ? {
              ...c,
              service: {
                staffMemberId: staffId,
                staffDisplayName: staff?.display_name ?? `#${staffId}`,
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
    if (unassignedServiceCount > 0) {
      toast.warning(
        `Hay ${unassignedServiceCount} servicio${unassignedServiceCount === 1 ? "" : "s"} sin artista asignado. Podés completarlo desde admin/orders después.`,
      );
    }
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

  // Keep cart pricing in sync with the catalogue once products.list resolves
  // (the optimistic cart row stores 0 until then).
  useEffect(() => {
    if (catalogue.length === 0) return;
    setCart((prev) =>
      prev.map((c) => {
        const fresh = catalogue.find((x) => x.productId === c.productId);
        if (!fresh) return c;
        if (fresh.unitPrice === c.unitPrice) return c;
        return { ...c, unitPrice: fresh.unitPrice };
      }),
    );
  }, [catalogue]);

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
          <CardTitle>Catálogo</CardTitle>
          <div className="relative !mt-4">
            <SearchIcon className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Buscar por nombre o SKU"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardHeader>
        <CardContent>
          <Combobox
            items={filteredCatalogue.map((c) => ({
              id: c.productId,
              name:
                c.kind === "service"
                  ? `🪡 ${c.name} (servicio)`
                  : `${c.name} (${c.onHand} on hand)`,
            }))}
            placeholder="Agregar al carrito"
            noSelect
            onSelect={(id) => handleAddCatalogueItem(Number(id))}
          />
          <div className="mt-3 max-h-80 overflow-y-auto text-sm space-y-4">
            {groupedCatalogue.services.length > 0 ? (
              <section>
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  <ScissorsIcon className="h-3.5 w-3.5" /> Servicios
                </h3>
                <ul className="space-y-1">
                  {groupedCatalogue.services.map((c) => (
                    <li
                      key={`svc-${c.productId}`}
                      className="flex items-center justify-between border-b py-1"
                    >
                      <button
                        type="button"
                        onClick={() => handleAddCatalogueItem(c.productId)}
                        className="flex-1 text-left hover:text-primary"
                      >
                        <span className="font-medium">{c.name}</span>
                        {c.defaultServiceKind ? (
                          <span className="text-xs text-muted-foreground ml-2">
                            · {c.defaultServiceKind}
                          </span>
                        ) : null}
                      </button>
                      <Badge variant="default">Servicio</Badge>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {groupedCatalogue.products.length > 0 ? (
              <section>
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  <PackageIcon className="h-3.5 w-3.5" /> Productos
                </h3>
                <ul className="space-y-1">
                  {groupedCatalogue.products.map((c) => (
                    <li
                      key={`prod-${c.productId}`}
                      className="flex items-center justify-between border-b py-1"
                    >
                      <button
                        type="button"
                        onClick={() => handleAddCatalogueItem(c.productId)}
                        className="flex-1 text-left hover:text-primary"
                      >
                        {c.name}
                      </button>
                      <Badge
                        variant={c.onHand > 5 ? "secondary" : "destructive"}
                      >
                        {c.onHand}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {filteredCatalogue.length === 0 ? (
              <p className="text-muted-foreground">Nada en el catálogo.</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Carrito</CardTitle>
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
                Agregá un ítem desde el catálogo.
              </p>
            ) : (
              <div className="space-y-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ítem</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cart.map((c) => (
                      <React.Fragment key={c.productId}>
                        <TableRow>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {c.kind === "service" ? (
                                <ScissorsIcon className="h-3.5 w-3.5 text-primary" />
                              ) : null}
                              <span>{c.name}</span>
                              {c.kind === "service" ? (
                                <Badge variant="default" className="text-[10px]">
                                  Servicio
                                </Badge>
                              ) : null}
                            </div>
                          </TableCell>
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
                              <span className="w-8 text-center">
                                {c.quantity}
                              </span>
                              <Button
                                size="icon"
                                variant="outline"
                                className="h-7 w-7"
                                onClick={() =>
                                  handleQuantityChange(c.productId, 1)
                                }
                                disabled={c.quantity >= c.onHand}
                              >
                                <PlusIcon className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleRemove(c.productId)}
                            >
                              <Trash2Icon className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                        {c.kind === "service" ? (
                          <TableRow>
                            <TableCell colSpan={3} className="!py-1">
                              {c.service ? (
                                <button
                                  type="button"
                                  onClick={() => openServiceDialog(c.productId)}
                                  className="flex w-full items-center justify-between rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs hover:bg-emerald-500/15"
                                >
                                  <span className="flex items-center gap-2">
                                    <UserIcon className="h-3.5 w-3.5" />
                                    Artista: <strong>{c.service.staffDisplayName}</strong>
                                    <span className="text-muted-foreground">
                                      · {c.service.serviceKind}
                                      {c.service.bodyLocation
                                        ? ` · ${c.service.bodyLocation}`
                                        : ""}
                                    </span>
                                  </span>
                                  <span className="text-muted-foreground underline">
                                    editar
                                  </span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => openServiceDialog(c.productId)}
                                  className="flex w-full items-center justify-between rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium hover:bg-amber-500/15"
                                >
                                  <span className="flex items-center gap-2">
                                    <UserIcon className="h-4 w-4" />
                                    Asignar artista
                                  </span>
                                  <span className="text-muted-foreground">
                                    requerido
                                  </span>
                                </button>
                              )}
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </React.Fragment>
                    ))}
                  </TableBody>
                </Table>
                {unassignedServiceCount > 0 ? (
                  <p className="text-xs text-amber-600">
                    {unassignedServiceCount} servicio
                    {unassignedServiceCount === 1 ? "" : "s"} sin artista
                    asignado. Podés confirmar igual y completarlo después.
                  </p>
                ) : null}
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              El servidor recomputa precios desde la DB al confirmar.
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
              Confirmar venta
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
            <DialogTitle>¿Quién realizó este servicio?</DialogTitle>
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
              <Label>Tipo de servicio</Label>
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
              <Label>Zona del cuerpo (opcional)</Label>
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
              Completar después
            </Button>
            <Button onClick={saveServiceIntent}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
