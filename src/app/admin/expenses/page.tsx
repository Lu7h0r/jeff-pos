"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ReceiptIcon, PlusCircleIcon } from "lucide-react";
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

type EntryFormState = {
  categoryId: string;
  amount: string;
  locationId: string;
  paymentMethodId: string;
  cashSessionId: string;
  description: string;
  incurredAt: string;
};

const EMPTY_ENTRY: EntryFormState = {
  categoryId: "",
  amount: "",
  locationId: "",
  paymentMethodId: "",
  cashSessionId: "",
  description: "",
  incurredAt: new Date().toISOString().slice(0, 10),
};

function formatMoney(minor: number) {
  return (minor / 100).toLocaleString("es-CO", {
    style: "currency",
    currency: "COP",
    minimumFractionDigits: 2,
  });
}

export default function ExpensesPage() {
  const trpc = useTRPC();

  const entriesQuery = useQuery(trpc.expenses.entries.list.queryOptions({}));
  const categoriesQuery = useQuery(trpc.expenses.categories.list.queryOptions());
  const locationsQuery = useQuery(trpc.locations.list.queryOptions());
  const paymentMethodsQuery = useQuery(trpc.paymentMethods.list.queryOptions());

  const entriesKey = trpc.expenses.entries.list.queryOptions({}).queryKey;
  const categoriesKey = trpc.expenses.categories.list.queryOptions().queryKey;

  const [entryDialogOpen, setEntryDialogOpen] = useState(false);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [entryForm, setEntryForm] = useState<EntryFormState>(EMPTY_ENTRY);
  const [categoryName, setCategoryName] = useState("");

  const createEntry = useCrudMutation({
    mutationOptions: trpc.expenses.entries.create.mutationOptions(),
    invalidateKeys: entriesKey,
    successMessage: "Expense registered",
    errorMessage: "Failed to register expense",
    onSuccess: () => {
      setEntryForm(EMPTY_ENTRY);
      setEntryDialogOpen(false);
    },
  });

  const createCategory = useCrudMutation({
    mutationOptions: trpc.expenses.categories.create.mutationOptions(),
    invalidateKeys: categoriesKey,
    successMessage: "Category created",
    errorMessage: "Failed to create category",
    onSuccess: () => {
      setCategoryName("");
      setCategoryDialogOpen(false);
    },
  });

  const entries = entriesQuery.data ?? [];
  const monthTotal = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return entries
      .filter((e) => new Date(e.incurred_at) >= start)
      .reduce((sum, e) => sum + e.amount, 0);
  }, [entries]);

  const submitEntry = () => {
    const amountMinor = Math.round(parseFloat(entryForm.amount) * 100);
    if (!entryForm.categoryId || !Number.isFinite(amountMinor) || amountMinor <= 0) {
      return;
    }
    createEntry.mutate({
      categoryId: Number(entryForm.categoryId),
      amount: amountMinor,
      incurredAt: new Date(entryForm.incurredAt),
      locationId: entryForm.locationId ? Number(entryForm.locationId) : undefined,
      paymentMethodId: entryForm.paymentMethodId
        ? Number(entryForm.paymentMethodId)
        : undefined,
      cashSessionId: entryForm.cashSessionId
        ? Number(entryForm.cashSessionId)
        : undefined,
      description: entryForm.description || undefined,
    });
  };

  const submitCategory = () => {
    if (!categoryName.trim()) return;
    createCategory.mutate({ name: categoryName.trim() });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <ReceiptIcon className="w-5 h-5" />
            <CardTitle>Expenses (current month)</CardTitle>
          </div>
          <div className="text-2xl font-semibold">{formatMoney(monthTotal)}</div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Categories</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setCategoryDialogOpen(true)}>
            <PlusCircleIcon className="w-4 h-4 mr-2" /> New category
          </Button>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-wrap gap-2">
            {(categoriesQuery.data ?? []).map((c) => (
              <li
                key={c.id}
                className="rounded-full border px-3 py-1 text-sm text-muted-foreground"
              >
                {c.name} <span className="text-xs">· {c.kind}</span>
              </li>
            ))}
            {categoriesQuery.data && categoriesQuery.data.length === 0 && (
              <li className="text-sm text-muted-foreground">No categories yet.</li>
            )}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Entries</CardTitle>
          <Button size="sm" onClick={() => setEntryDialogOpen(true)}>
            <PlusCircleIcon className="w-4 h-4 mr-2" /> New expense
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    {new Date(e.incurred_at).toLocaleDateString("es-CO")}
                  </TableCell>
                  <TableCell>{e.category_name}</TableCell>
                  <TableCell>{e.description ?? "—"}</TableCell>
                  <TableCell className="text-right">{formatMoney(e.amount)}</TableCell>
                </TableRow>
              ))}
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No expenses registered.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={entryDialogOpen} onOpenChange={setEntryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New expense</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>Category</Label>
              <Select
                value={entryForm.categoryId}
                onValueChange={(v) => setEntryForm((s) => ({ ...s, categoryId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {(categoriesQuery.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Amount (COP)</Label>
              <Input
                type="number"
                step="0.01"
                value={entryForm.amount}
                onChange={(e) => setEntryForm((s) => ({ ...s, amount: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={entryForm.incurredAt}
                onChange={(e) =>
                  setEntryForm((s) => ({ ...s, incurredAt: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>Location (optional)</Label>
              <Select
                value={entryForm.locationId}
                onValueChange={(v) => setEntryForm((s) => ({ ...s, locationId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Business-wide" />
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
              <Label>Payment method (optional)</Label>
              <Select
                value={entryForm.paymentMethodId}
                onValueChange={(v) =>
                  setEntryForm((s) => ({ ...s, paymentMethodId: v }))
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
                value={entryForm.cashSessionId}
                onChange={(e) =>
                  setEntryForm((s) => ({ ...s, cashSessionId: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>Description</Label>
              <Input
                value={entryForm.description}
                onChange={(e) =>
                  setEntryForm((s) => ({ ...s, description: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEntryDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitEntry} disabled={createEntry.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New category</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label>Name</Label>
            <Input
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              placeholder="e.g. Insumos"
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCategoryDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitCategory} disabled={createCategory.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
