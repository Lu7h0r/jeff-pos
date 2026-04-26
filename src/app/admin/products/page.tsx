"use client";

import { useState, useMemo } from "react";
import { useForm } from "@tanstack/react-form";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { FilePenIcon, TrashIcon, PlusIcon, PackageIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { useCrudMutation } from "@/hooks/use-crud-mutation";
import { DataTable, TableActions, TableActionButton, type Column, type ExportColumn } from "@/components/ui/data-table";
import { SearchFilter, type FilterOption } from "@/components/ui/search-filter";
import type { RouterOutputs } from "@/lib/trpc/router";

type Product = RouterOutputs["products"]["list"][number];
type ProductKind = "product" | "service";
type ServiceKind =
  | "tattoo"
  | "piercing"
  | "touchup"
  | "removal"
  | "consultation"
  | "other";

const SERVICE_KIND_OPTIONS: ServiceKind[] = [
  "tattoo",
  "piercing",
  "touchup",
  "removal",
  "consultation",
  "other",
];

const productFormSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string(),
    price: z.number().min(0, "Price must be positive"),
    in_stock: z.number().int().min(0, "Stock must be non-negative"),
    category: z.string(),
    kind: z.enum(["product", "service"]),
    default_service_kind: z.string(),
  })
  .refine(
    (v) => v.kind !== "service" || v.default_service_kind !== "",
    {
      message: "Pick a service kind",
      path: ["default_service_kind"],
    },
  );

const categoryFilterOptions: FilterOption[] = [
  { label: "All", value: "all" },
  { label: "Electronics", value: "electronics" },
  { label: "Home", value: "home" },
  { label: "Health", value: "health" },
];

const stockFilterOptions: FilterOption[] = [
  { label: "All Stock", value: "all" },
  { label: "In Stock", value: "in-stock", variant: "success" },
  { label: "Out of Stock", value: "out-of-stock", variant: "danger" },
];

const kindFilterOptions: FilterOption[] = [
  { label: "All", value: "all" },
  { label: "Productos", value: "product" },
  { label: "Servicios", value: "service", variant: "success" },
];

const columns: Column<Product>[] = [
  { key: "name", header: "Product", sortable: true, className: "font-medium" },
  {
    key: "kind",
    header: "Tipo",
    sortable: true,
    render: (row) =>
      row.kind === "service" ? (
        <Badge variant="default">
          Servicio{row.default_service_kind ? ` · ${row.default_service_kind}` : ""}
        </Badge>
      ) : (
        <Badge variant="secondary">Producto</Badge>
      ),
  },
  { key: "description", header: "Description", hideOnMobile: true },
  {
    key: "price",
    header: "Price",
    sortable: true,
    accessorFn: (row) => row.price,
    render: (row) => `$${(row.price / 100).toFixed(2)}`,
  },
  { key: "in_stock", header: "Stock", sortable: true },
];

const exportColumns: ExportColumn<Product>[] = [
  { key: "name", header: "Name", getValue: (p) => p.name },
  { key: "kind", header: "Kind", getValue: (p) => p.kind },
  {
    key: "default_service_kind",
    header: "Service Kind",
    getValue: (p) => p.default_service_kind ?? "",
  },
  { key: "description", header: "Description", getValue: (p) => p.description ?? "" },
  { key: "price", header: "Price", getValue: (p) => (p.price / 100).toFixed(2) },
  { key: "in_stock", header: "Stock", getValue: (p) => p.in_stock },
  { key: "category", header: "Category", getValue: (p) => p.category ?? "" },
];

export default function Products() {
  const trpc = useTRPC();
  const { data: products = [], isLoading } = useQuery(trpc.products.list.queryOptions());

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");

  const isEditing = editingId !== null;
  const invalidateKeys = trpc.products.list.queryOptions().queryKey;

  const createMutation = useCrudMutation({
    mutationOptions: trpc.products.create.mutationOptions(),
    invalidateKeys,
    successMessage: "Product created",
    errorMessage: "Failed to create product",
    onSuccess: () => setIsDialogOpen(false),
  });

  const updateMutation = useCrudMutation({
    mutationOptions: trpc.products.update.mutationOptions(),
    invalidateKeys,
    successMessage: "Product updated",
    errorMessage: "Failed to update product",
    onSuccess: () => setIsDialogOpen(false),
  });

  const deleteMutation = useCrudMutation({
    mutationOptions: trpc.products.delete.mutationOptions(),
    invalidateKeys,
    successMessage: "Product deleted",
    errorMessage: "Failed to delete product",
  });

  const form = useForm({
    defaultValues: {
      name: "",
      description: "",
      price: 0,
      in_stock: 0,
      category: "",
      kind: "product" as ProductKind,
      default_service_kind: "",
    },
    validators: {
      onSubmit: productFormSchema,
    },
    onSubmit: ({ value }) => {
      const isService = value.kind === "service";
      const basePayload = {
        name: value.name,
        description: value.description || undefined,
        price: Math.round(value.price * 100),
        in_stock: value.in_stock,
        category: value.category || undefined,
      };
      if (isEditing) {
        updateMutation.mutate({
          id: editingId,
          ...basePayload,
          kind: value.kind,
          default_service_kind: isService
            ? (value.default_service_kind as ServiceKind)
            : null,
        });
      } else {
        createMutation.mutate({
          ...basePayload,
          kind: value.kind,
          default_service_kind: isService
            ? (value.default_service_kind as ServiceKind)
            : undefined,
        });
      }
    },
  });

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      if (kindFilter !== "all" && p.kind !== kindFilter) return false;
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (stockFilter === "in-stock" && p.in_stock === 0) return false;
      if (stockFilter === "out-of-stock" && p.in_stock > 0) return false;
      return p.name.toLowerCase().includes(searchTerm.toLowerCase());
    });
  }, [products, kindFilter, categoryFilter, stockFilter, searchTerm]);

  const openCreate = () => {
    setEditingId(null);
    form.reset();
    setIsDialogOpen(true);
  };

  const openEdit = (p: Product) => {
    setEditingId(p.id);
    form.reset();
    form.setFieldValue("name", p.name);
    form.setFieldValue("description", p.description ?? "");
    form.setFieldValue("price", p.price / 100);
    form.setFieldValue("in_stock", p.in_stock);
    form.setFieldValue("category", p.category ?? "");
    form.setFieldValue("kind", p.kind);
    form.setFieldValue("default_service_kind", p.default_service_kind ?? "");
    setIsDialogOpen(true);
  };

  const handleDelete = () => {
    if (deleteId !== null) {
      deleteMutation.mutate({ id: deleteId });
      setIsDeleteOpen(false);
      setDeleteId(null);
    }
  };

  const actionsColumn: Column<Product> = {
    key: "actions",
    header: "Actions",
    render: (row) => (
      <TableActions>
        <TableActionButton onClick={() => openEdit(row)} icon={<FilePenIcon className="w-4 h-4" />} label="Edit" />
        <TableActionButton variant="danger" onClick={() => { setDeleteId(row.id); setIsDeleteOpen(true); }} icon={<TrashIcon className="w-4 h-4" />} label="Delete" />
      </TableActions>
    ),
  };

  if (isLoading) {
    return (
      <Card className="flex flex-col gap-4 p-3 sm:gap-6 sm:p-6">
        <CardHeader className="p-0"><div className="flex items-center justify-between"><Skeleton className="h-10 w-48" /><Skeleton className="h-9 w-32" /></div></CardHeader>
        <CardContent className="p-0 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (<div key={i} className="flex items-center gap-4"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-48" /><Skeleton className="h-4 w-16" /><Skeleton className="h-4 w-12" /><Skeleton className="h-8 w-20" /></div>))}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="flex flex-col gap-4 p-3 sm:gap-6 sm:p-6">
        <CardHeader className="p-0">
          <SearchFilter
            search={searchTerm}
            onSearchChange={setSearchTerm}
            searchPlaceholder="Search products..."
            filters={[
              { options: kindFilterOptions, value: kindFilter, onChange: setKindFilter },
              { options: categoryFilterOptions, value: categoryFilter, onChange: setCategoryFilter },
              { options: stockFilterOptions, value: stockFilter, onChange: setStockFilter },
            ]}
          >
            <Button size="sm" onClick={openCreate}>
              <PlusIcon className="w-4 h-4 mr-2" />Add Product
            </Button>
          </SearchFilter>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            data={filteredProducts}
            columns={[...columns, actionsColumn]}
            exportColumns={exportColumns}
            exportFilename="products"
            emptyMessage="No products found."
            emptyIcon={<PackageIcon className="w-8 h-8" />}
            defaultSort={[{ id: "name", desc: false }]}
          />
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) setIsDialogOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Product" : "Add New Product"}</DialogTitle>
            <DialogDescription>{isEditing ? "Edit the details of the product." : "Enter the details of the new product."}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
          >
            <div className="grid gap-4 py-4">
              <form.Field name="kind">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="kind" className="sm:text-right">Tipo</Label>
                    <Select
                      value={field.state.value}
                      onValueChange={(v) => {
                        const next = v as ProductKind;
                        field.handleChange(next);
                        if (next === "product") {
                          form.setFieldValue("default_service_kind", "");
                        }
                      }}
                    >
                      <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="product">Producto</SelectItem>
                        <SelectItem value="service">Servicio</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </form.Field>
              <form.Subscribe selector={(s) => s.values.kind}>
                {(kind) =>
                  kind === "service" ? (
                    <form.Field name="default_service_kind">
                      {(field) => (
                        <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                          <Label htmlFor="default_service_kind" className="sm:text-right">Tipo de servicio</Label>
                          <div className="col-span-3">
                            <Select
                              value={field.state.value}
                              onValueChange={(v) => field.handleChange(v)}
                            >
                              <SelectTrigger><SelectValue placeholder="Tatuaje, piercing, ..." /></SelectTrigger>
                              <SelectContent>
                                {SERVICE_KIND_OPTIONS.map((sk) => (
                                  <SelectItem key={sk} value={sk}>{sk}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {field.state.meta.errors.length > 0 ? (
                              <p className="text-xs text-destructive mt-1">
                                {field.state.meta.errors.map((e) => e?.message ?? e).join(", ")}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      )}
                    </form.Field>
                  ) : null
                }
              </form.Subscribe>
              <form.Field name="name">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="name" className="sm:text-right">Name</Label>
                    <div className="col-span-3">
                      <Input
                        id="name"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        error={field.state.meta.errors.length > 0 ? field.state.meta.errors.map(e => e?.message ?? e).join(", ") : undefined}
                      />
                    </div>
                  </div>
                )}
              </form.Field>
              <form.Field name="description">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="description" className="sm:text-right">Description</Label>
                    <Input id="description" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} className="col-span-3" />
                  </div>
                )}
              </form.Field>
              <form.Field name="price">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="price" className="sm:text-right">Price</Label>
                    <div className="col-span-3">
                      <Input
                        id="price"
                        type="number"
                        step="0.01"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(Number(e.target.value))}
                        onBlur={field.handleBlur}
                        error={field.state.meta.errors.length > 0 ? field.state.meta.errors.map(e => e?.message ?? e).join(", ") : undefined}
                      />
                    </div>
                  </div>
                )}
              </form.Field>
              <form.Field name="in_stock">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="in_stock" className="sm:text-right">In Stock</Label>
                    <div className="col-span-3">
                      <Input
                        id="in_stock"
                        type="number"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(Number(e.target.value))}
                        onBlur={field.handleBlur}
                        error={field.state.meta.errors.length > 0 ? field.state.meta.errors.map(e => e?.message ?? e).join(", ") : undefined}
                      />
                    </div>
                  </div>
                )}
              </form.Field>
              <form.Field name="category">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="category" className="sm:text-right">Category</Label>
                    <Select value={field.state.value} onValueChange={(value) => field.handleChange(value)}>
                      <SelectTrigger className="col-span-3"><SelectValue placeholder="Select a category" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="electronics">Electronics</SelectItem>
                        <SelectItem value="clothing">Clothing</SelectItem>
                        <SelectItem value="books">Books</SelectItem>
                        <SelectItem value="home">Home</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </form.Field>
            </div>
            <DialogFooter>
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <Button type="submit" disabled={isSubmitting || createMutation.isPending || updateMutation.isPending}>
                    {isEditing ? "Update Product" : "Add Product"}
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} onConfirm={handleDelete} description="Are you sure you want to delete this product? This action cannot be undone." />
    </>
  );
}
