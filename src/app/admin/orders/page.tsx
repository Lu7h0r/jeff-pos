"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { FilePenIcon, TrashIcon, EyeIcon, ShoppingCartIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { useCrudMutation } from "@/hooks/use-crud-mutation";
import { DataTable, TableActions, TableActionButton, type Column, type ExportColumn } from "@/components/ui/data-table";
import { SearchFilter, type FilterOption } from "@/components/ui/search-filter";
import { formatCurrency, formatDateOnly } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc/router";

type Order = RouterOutputs["orders"]["list"][number];

export default function OrdersPage() {
  const t = useTranslations("orders");
  const tCommon = useTranslations("common");
  const trpc = useTRPC();
  const { data: orders = [], isLoading, error } = useQuery(trpc.orders.list.queryOptions());

  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const invalidateKeys = trpc.orders.list.queryOptions().queryKey;

  const statusFilterOptions: FilterOption[] = [
    { label: t("filterAll"), value: "all" },
    { label: t("filterComplete"), value: "complete", variant: "success" },
    { label: t("filterPending"), value: "pending", variant: "warning" },
    { label: t("filterVoid"), value: "void", variant: "danger" },
  ];

  const tableColumns: Column<Order>[] = [
    { key: "id", header: t("colId"), sortable: true },
    {
      key: "customer",
      header: t("colCustomer"),
      sortable: true,
      accessorFn: (row) => row.customer?.name ?? "",
      render: (row) => row.customer?.name ?? "",
    },
    {
      key: "total_amount",
      header: t("colTotal"),
      sortable: true,
      accessorFn: (row) => row.total_amount,
      render: (row) => formatCurrency(row.total_amount),
    },
    {
      key: "process_status",
      header: t("colStatus"),
      sortable: true,
      render: (row) => {
        const s = row.process_status;
        const color =
          s === "complete"
            ? "text-green-600"
            : s === "void"
              ? "text-red-600"
              : "text-yellow-600";
        const label =
          s === "complete"
            ? t("statusComplete")
            : s === "void"
              ? t("statusVoid")
              : t("statusPending");
        return <span className={color}>{label}</span>;
      },
    },
    {
      key: "created_at",
      header: t("colDate"),
      sortable: true,
      hideOnMobile: true,
      accessorFn: (row) => row.created_at ? new Date(row.created_at).getTime() : 0,
      render: (row) => row.created_at ? formatDateOnly(row.created_at) : "",
    },
  ];

  const exportColumns: ExportColumn<Order>[] = [
    { key: "id", header: t("colId"), getValue: (o) => o.id },
    { key: "customer", header: t("colCustomer"), getValue: (o) => o.customer?.name ?? "" },
    { key: "total", header: t("colTotal"), getValue: (o) => o.total_amount },
    { key: "status", header: t("colStatus"), getValue: (o) => o.process_status },
    { key: "date", header: t("colDate"), getValue: (o) => o.created_at ? formatDateOnly(o.created_at) : "" },
  ];

  const editNotesMutation = useCrudMutation({
    mutationOptions: trpc.orders.editNotes.mutationOptions(),
    invalidateKeys,
    successMessage: t("notesUpdated"),
    errorMessage: t("notesUpdateFailed"),
    onSuccess: () => {
      setIsNotesOpen(false);
      setEditingOrder(null);
    },
  });

  const voidMutation = useCrudMutation({
    mutationOptions: trpc.orders.void.mutationOptions(),
    invalidateKeys,
    successMessage: t("voided"),
    errorMessage: t("voidFailed"),
  });

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (statusFilter !== "all" && o.process_status !== statusFilter) return false;
      const q = searchTerm.toLowerCase();
      return (o.customer?.name ?? "").toLowerCase().includes(q) || o.id.toString().includes(searchTerm);
    });
  }, [orders, statusFilter, searchTerm]);

  const openNotesEditor = (o: Order) => {
    setEditingOrder(o);
    setNotesDraft(o.notes ?? "");
    setIsNotesOpen(true);
  };

  const submitNotes = () => {
    if (!editingOrder) return;
    editNotesMutation.mutate({
      orderId: editingOrder.id,
      notes: notesDraft,
    });
  };

  const handleVoid = () => {
    if (deleteId !== null) {
      const reason = typeof window !== "undefined"
        ? window.prompt(t("voidPromptTitle")) ?? ""
        : "";
      if (reason.trim().length >= 3) {
        voidMutation.mutate({ orderId: deleteId, voidanceReason: reason.trim() });
      }
      setIsDeleteOpen(false);
      setDeleteId(null);
    }
  };

  const actionsColumn: Column<Order> = {
    key: "actions",
    header: tCommon("actions"),
    render: (row) => (
      <TableActions>
        <TableActionButton onClick={() => openNotesEditor(row)} icon={<FilePenIcon className="w-4 h-4" />} label={t("editNotes")} />
        <TableActionButton variant="danger" onClick={() => { setDeleteId(row.id); setIsDeleteOpen(true); }} icon={<TrashIcon className="w-4 h-4" />} label={t("voidAction")} />
        <Link href={`/admin/orders/${row.id}`} prefetch={false} onClick={(e) => e.stopPropagation()}>
          <Button size="icon" variant="ghost"><EyeIcon className="w-4 h-4" /><span className="sr-only">{t("viewAction")}</span></Button>
        </Link>
      </TableActions>
    ),
  };

  if (isLoading) {
    return (
      <Card className="flex flex-col gap-6 p-6">
        <CardHeader className="p-0"><div className="flex items-center justify-between"><Skeleton className="h-10 w-48" /><Skeleton className="h-9 w-32" /></div></CardHeader>
        <CardContent className="p-0 space-y-3">{Array.from({ length: 5 }).map((_, i) => (<div key={i} className="flex items-center gap-4"><Skeleton className="h-4 w-12" /><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-24" /></div>))}</CardContent>
      </Card>
    );
  }

  if (error) { return <Card><CardContent><p className="text-red-500">{error.message}</p></CardContent></Card>; }

  return (
    <Card className="flex flex-col gap-4 p-3 sm:gap-6 sm:p-6">
      <CardHeader className="p-0">
        <SearchFilter
          search={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder={t("searchPlaceholder")}
          filters={[{ options: statusFilterOptions, value: statusFilter, onChange: setStatusFilter }]}
        />
      </CardHeader>
      <CardContent className="p-0">
        <DataTable
          data={filteredOrders}
          columns={[...tableColumns, actionsColumn]}
          exportColumns={exportColumns}
          exportFilename="ordenes"
          emptyMessage={t("empty")}
          emptyIcon={<ShoppingCartIcon className="w-8 h-8" />}
          defaultSort={[{ id: "created_at", desc: true }]}
        />
      </CardContent>

      <Dialog open={isNotesOpen} onOpenChange={(open) => { if (!open) { setIsNotesOpen(false); setEditingOrder(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editNotesTitle", { id: editingOrder?.id ?? "" })}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <p className="text-xs text-muted-foreground">{t("editNotesHelp")}</p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="order-notes">{tCommon("notes")}</Label>
              <textarea
                id="order-notes"
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                rows={5}
                placeholder={t("notesPlaceholder")}
                className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => { setIsNotesOpen(false); setEditingOrder(null); }}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={submitNotes} disabled={editNotesMutation.isPending || !editingOrder}>
              {t("saveNotes")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} onConfirm={handleVoid} description={t("voidConfirmDescription")} />
    </Card>
  );
}
