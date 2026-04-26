"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ReceiptIcon, PlusCircleIcon } from "lucide-react";
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

export default function ExpensesPage() {
  const t = useTranslations("expenses");
  const tc = useTranslations("common");
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
    successMessage: t("expenseRegistered"),
    errorMessage: t("expenseRegisterFailed"),
    onSuccess: () => {
      setEntryForm(EMPTY_ENTRY);
      setEntryDialogOpen(false);
    },
  });

  const createCategory = useCrudMutation({
    mutationOptions: trpc.expenses.categories.create.mutationOptions(),
    invalidateKeys: categoriesKey,
    successMessage: t("categoryCreated"),
    errorMessage: t("categoryCreateFailed"),
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
            <CardTitle>{t("monthCardTitle")}</CardTitle>
          </div>
          <div className="text-2xl font-semibold">{formatCurrency(monthTotal)}</div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t("categoriesTitle")}</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setCategoryDialogOpen(true)}>
            <PlusCircleIcon className="w-4 h-4 mr-2" /> {t("newCategory")}
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
              <li className="text-sm text-muted-foreground">{t("categoryEmpty")}</li>
            )}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t("entriesTitle")}</CardTitle>
          <Button size="sm" onClick={() => setEntryDialogOpen(true)}>
            <PlusCircleIcon className="w-4 h-4 mr-2" /> {t("newExpense")}
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colDate")}</TableHead>
                <TableHead>{t("colCategory")}</TableHead>
                <TableHead>{t("colDescription")}</TableHead>
                <TableHead className="text-right">{t("colAmount")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    {new Date(e.incurred_at).toLocaleDateString("es-AR")}
                  </TableCell>
                  <TableCell>{e.category_name}</TableCell>
                  <TableCell>{e.description ?? "—"}</TableCell>
                  <TableCell className="text-right">{formatCurrency(e.amount)}</TableCell>
                </TableRow>
              ))}
              {entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    {t("empty")}
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
            <DialogTitle>{t("newExpenseTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>{t("categoryLabel")}</Label>
              <Select
                value={entryForm.categoryId}
                onValueChange={(v) => setEntryForm((s) => ({ ...s, categoryId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("selectCategory")} />
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
              <Label>{t("amountLabel")}</Label>
              <Input
                type="number"
                step="0.01"
                value={entryForm.amount}
                onChange={(e) => setEntryForm((s) => ({ ...s, amount: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("dateLabel")}</Label>
              <Input
                type="date"
                value={entryForm.incurredAt}
                onChange={(e) =>
                  setEntryForm((s) => ({ ...s, incurredAt: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("locationOptional")}</Label>
              <Select
                value={entryForm.locationId}
                onValueChange={(v) => setEntryForm((s) => ({ ...s, locationId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("businessWide")} />
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
              <Label>{t("paymentMethodOptional")}</Label>
              <Select
                value={entryForm.paymentMethodId}
                onValueChange={(v) =>
                  setEntryForm((s) => ({ ...s, paymentMethodId: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("noneOption")} />
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
              <Label>{t("cashSessionId")}</Label>
              <Input
                type="number"
                value={entryForm.cashSessionId}
                onChange={(e) =>
                  setEntryForm((s) => ({ ...s, cashSessionId: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("descriptionLabel")}</Label>
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
              {tc("cancel")}
            </Button>
            <Button onClick={submitEntry} disabled={createEntry.isPending}>
              {tc("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("newCategoryTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label>{tc("name")}</Label>
            <Input
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              placeholder={t("categoryNamePlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCategoryDialogOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button onClick={submitCategory} disabled={createCategory.isPending}>
              {tc("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
