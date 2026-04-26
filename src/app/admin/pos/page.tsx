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

const ACTIVE_LOCATION_COOKIE = "jeff_active_location_id";

type CartItem = {
  productId: number;
  name: string;
  unitPrice: number;
  onHand: number;
  quantity: number;
};

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

  const createOrderMutation = useMutation(
    trpc.orders.create.mutationOptions({
      onSuccess: (order) => {
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
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemove(c.productId)}
                        >
                          <Trash2Icon className="h-4 w-4" />
                        </Button>
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
    </div>
  );
}
