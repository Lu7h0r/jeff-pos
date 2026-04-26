"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { FilePenIcon, TrashIcon, EyeIcon, ShoppingCartIcon } from "lucide-react";
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
import type { RouterOutputs } from "@/lib/trpc/router";

type Order = RouterOutputs["orders"]["list"][number];

const statusFilterOptions: FilterOption[] = [
  { label: "All", value: "all" },
  { label: "Complete", value: "complete", variant: "success" },
  { label: "Pending", value: "pending", variant: "warning" },
  { label: "Void", value: "void", variant: "danger" },
];

const tableColumns: Column<Order>[] = [
  { key: "id", header: "Order ID", sortable: true },
  {
    key: "customer",
    header: "Customer",
    sortable: true,
    accessorFn: (row) => row.customer?.name ?? "",
    render: (row) => row.customer?.name ?? "",
  },
  {
    key: "total_amount",
    header: "Total",
    sortable: true,
    accessorFn: (row) => row.total_amount,
    render: (row) => `$${(row.total_amount / 100).toFixed(2)}`,
  },
  {
    key: "process_status",
    header: "Status",
    sortable: true,
    render: (row) => {
      const s = row.process_status;
      const color =
        s === "complete"
          ? "text-green-600"
          : s === "void"
            ? "text-red-600"
            : "text-yellow-600";
      return <span className={color}>{s.charAt(0).toUpperCase() + s.slice(1)}</span>;
    },
  },
  {
    key: "created_at",
    header: "Date",
    sortable: true,
    hideOnMobile: true,
    accessorFn: (row) => row.created_at ? new Date(row.created_at).getTime() : 0,
    render: (row) => row.created_at ? new Date(row.created_at).toLocaleDateString() : "",
  },
];

const exportColumns: ExportColumn<Order>[] = [
  { key: "id", header: "Order ID", getValue: (o) => o.id },
  { key: "customer", header: "Customer", getValue: (o) => o.customer?.name ?? "" },
  { key: "total", header: "Total", getValue: (o) => (o.total_amount / 100).toFixed(2) },
  { key: "status", header: "Status", getValue: (o) => o.process_status },
  { key: "date", header: "Date", getValue: (o) => o.created_at ? new Date(o.created_at).toLocaleDateString() : "" },
];

export default function OrdersPage() {
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

  // Closes DA-8: total/status changes are no longer editable. The only
  // post-sale mutation is notes; total/state changes go through void +
  // new sale.
  const editNotesMutation = useCrudMutation({
    mutationOptions: trpc.orders.editNotes.mutationOptions(),
    invalidateKeys,
    successMessage: "Notes updated",
    errorMessage: "Failed to update notes",
    onSuccess: () => {
      setIsNotesOpen(false);
      setEditingOrder(null);
    },
  });

  const voidMutation = useCrudMutation({
    mutationOptions: trpc.orders.void.mutationOptions(),
    invalidateKeys,
    successMessage: "Order voided",
    errorMessage: "Failed to void order",
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
        ? window.prompt("Reason for voiding this order (min 3 characters):") ?? ""
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
    header: "Actions",
    render: (row) => (
      <TableActions>
        <TableActionButton onClick={() => openNotesEditor(row)} icon={<FilePenIcon className="w-4 h-4" />} label="Editar notas" />
        <TableActionButton variant="danger" onClick={() => { setDeleteId(row.id); setIsDeleteOpen(true); }} icon={<TrashIcon className="w-4 h-4" />} label="Anular" />
        <Link href={`/admin/orders/${row.id}`} prefetch={false} onClick={(e) => e.stopPropagation()}>
          <Button size="icon" variant="ghost"><EyeIcon className="w-4 h-4" /><span className="sr-only">View</span></Button>
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
          searchPlaceholder="Search orders..."
          filters={[{ options: statusFilterOptions, value: statusFilter, onChange: setStatusFilter }]}
        />
      </CardHeader>
      <CardContent className="p-0">
        <DataTable
          data={filteredOrders}
          columns={[...tableColumns, actionsColumn]}
          exportColumns={exportColumns}
          exportFilename="orders"
          emptyMessage="No orders found."
          emptyIcon={<ShoppingCartIcon className="w-8 h-8" />}
          defaultSort={[{ id: "created_at", desc: true }]}
        />
      </CardContent>

      <Dialog open={isNotesOpen} onOpenChange={(open) => { if (!open) { setIsNotesOpen(false); setEditingOrder(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar notas — Orden #{editingOrder?.id ?? ""}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <p className="text-xs text-muted-foreground">
              Total y estado no son editables. Para corregir una venta, usá Anular y registrá una venta nueva.
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="order-notes">Notas</Label>
              <textarea
                id="order-notes"
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                rows={5}
                placeholder="Notas internas de la orden"
                className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => { setIsNotesOpen(false); setEditingOrder(null); }}>
              Cancelar
            </Button>
            <Button onClick={submitNotes} disabled={editNotesMutation.isPending || !editingOrder}>
              Guardar notas
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} onConfirm={handleVoid} description="Voiding will reverse stock and cash. The row is preserved for audit. You will be asked for a reason." />
    </Card>
  );
}
