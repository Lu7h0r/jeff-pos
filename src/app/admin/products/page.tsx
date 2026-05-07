"use client";

import { useState, useMemo, useRef } from "react";
import { useForm } from "@tanstack/react-form";
import { z } from "zod/v4";
import { useTranslations } from "next-intl";
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
import { formatCurrency } from "@/lib/utils";
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

function parseImageUrlsInput(raw: string): string[] {
  return raw
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_EXTRA_IMAGES = 8;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

function mergeUniqueUrls(currentRaw: string, incomingUrls: string[]): string {
  const existing = parseImageUrlsInput(currentRaw);
  const seen = new Set(existing);
  const merged = [...existing];
  for (const url of incomingUrls) {
    if (!seen.has(url)) {
      seen.add(url);
      merged.push(url);
    }
  }
  return merged.join("\n");
}

function removeUrlFromRaw(currentRaw: string, urlToRemove: string): string {
  return parseImageUrlsInput(currentRaw)
    .filter((url) => url !== urlToRemove)
    .join("\n");
}

export default function Products() {
  const t = useTranslations("products");
  const tc = useTranslations("common");
  const tv = useTranslations("validation");
  const trpc = useTRPC();
  const { data: products = [], isLoading } = useQuery(trpc.products.list.queryOptions());
  const categoriesQuery = useQuery(trpc.products.categories.list.queryOptions());

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isUploadingExtraImages, setIsUploadingExtraImages] = useState(false);
  const [isDropzoneActive, setIsDropzoneActive] = useState(false);
  const [isExtraDropzoneActive, setIsExtraDropzoneActive] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const [extraImagesUploadError, setExtraImagesUploadError] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const extraImagesInputRef = useRef<HTMLInputElement | null>(null);

  const isEditing = editingId !== null;
  const invalidateKeys = trpc.products.list.queryOptions().queryKey;
  const categoriesKey = trpc.products.categories.list.queryOptions().queryKey;
  const CREATE_CATEGORY_VALUE = "__create_category__";

  const tServiceKind = (k: ServiceKind) => t(`serviceKinds.${k}`);

  const productFormSchema = z
    .object({
      name: z.string().min(1, tv("nameRequired")),
      description: z.string(),
      price: z.number().min(0, tv("mustBePositive")),
      cost_amount: z.number().min(0, tv("mustBePositive")),
      in_stock: z.number().int().min(0, tv("stockNonNegative")),
      category: z.string(),
      image_url: z.string(),
      image_urls: z.string(),
      kind: z.enum(["product", "service"]),
      default_service_kind: z.string(),
    })
    .refine((v) => v.cost_amount <= v.price, {
      message: t("costExceedsPrice"),
      path: ["cost_amount"],
    })
    .refine(
      (v) => v.kind !== "service" || v.default_service_kind !== "",
      {
        message: tv("pickServiceKind"),
        path: ["default_service_kind"],
      },
    );

  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ label: string; value: string }> = [];
    for (const category of categoriesQuery.data ?? []) {
      const name = category.name.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      options.push({ label: name, value: name });
    }
    for (const product of products) {
      const name = product.category?.trim() ?? "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      options.push({ label: name, value: name });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label, "es"));
  }, [categoriesQuery.data, products]);

  const categoryFilterOptions: FilterOption[] = useMemo(
    () => [
      { label: t("categoryAll"), value: "all" },
      ...categoryOptions,
    ],
    [t, categoryOptions],
  );

  const stockFilterOptions: FilterOption[] = [
    { label: t("stockAll"), value: "all" },
    { label: t("stockIn"), value: "in-stock", variant: "success" },
    { label: t("stockOut"), value: "out-of-stock", variant: "danger" },
  ];

  const kindFilterOptions: FilterOption[] = [
    { label: t("filterAll"), value: "all" },
    { label: t("filterProducts"), value: "product" },
    { label: t("filterServices"), value: "service", variant: "success" },
  ];

  const columns: Column<Product>[] = [
    {
      key: "image_preview",
      header: "Imagen",
      hideOnMobile: true,
      render: (row) => {
        const previewUrl = row.image_url || row.image_urls[0] || "";
        if (!previewUrl) {
          return (
            <div className="h-10 w-10 rounded-md border border-dashed border-muted-foreground/40 bg-muted/30" />
          );
        }
        return (
          <img
            src={previewUrl}
            alt={`Imagen de ${row.name}`}
            className="h-10 w-10 rounded-md border object-cover"
            loading="lazy"
          />
        );
      },
    },
    { key: "name", header: t("colProduct"), sortable: true, className: "font-medium" },
    {
      key: "kind",
      header: t("colKind"),
      sortable: true,
      render: (row) =>
        row.kind === "service" ? (
          <Badge variant="default">
            {row.default_service_kind
              ? t("kindServiceWith", {
                  kind: tServiceKind(row.default_service_kind as ServiceKind),
                })
              : t("kindService")}
          </Badge>
        ) : (
          <Badge variant="secondary">{t("kindProduct")}</Badge>
        ),
    },
    { key: "description", header: t("colDescription"), hideOnMobile: true },
    {
      key: "price",
      header: t("colPrice"),
      sortable: true,
      accessorFn: (row) => row.price,
      render: (row) => formatCurrency(row.price),
    },
    {
      key: "cost_amount",
      header: t("colCost"),
      sortable: true,
      accessorFn: (row) => row.cost_amount ?? 0,
      render: (row) => formatCurrency(row.cost_amount ?? 0),
    },
    {
      key: "unit_profit",
      header: t("colProfit"),
      accessorFn: (row) => row.price - (row.cost_amount ?? 0),
      render: (row) => formatCurrency(row.price - (row.cost_amount ?? 0)),
    },
    {
      key: "margin_percent",
      header: t("colMargin"),
      accessorFn: (row) => {
        if (row.price <= 0) return 0;
        return ((row.price - (row.cost_amount ?? 0)) / row.price) * 100;
      },
      render: (row) => {
        if (row.price <= 0) return "0.0%";
        const margin = ((row.price - (row.cost_amount ?? 0)) / row.price) * 100;
        return `${margin.toFixed(1)}%`;
      },
    },
    { key: "in_stock", header: t("colStock"), sortable: true },
  ];

  const exportColumns: ExportColumn<Product>[] = [
    { key: "name", header: tc("name"), getValue: (p) => p.name },
    { key: "kind", header: t("colKind"), getValue: (p) => p.kind },
    {
      key: "default_service_kind",
      header: t("serviceKindLabel"),
      getValue: (p) => p.default_service_kind ?? "",
    },
    { key: "description", header: t("colDescription"), getValue: (p) => p.description ?? "" },
    { key: "price", header: t("colPrice"), getValue: (p) => (p.price / 100).toFixed(2) },
    {
      key: "cost_amount",
      header: t("colCost"),
      getValue: (p) => ((p.cost_amount ?? 0) / 100).toFixed(2),
    },
    {
      key: "unit_profit",
      header: t("colProfit"),
      getValue: (p) => ((p.price - (p.cost_amount ?? 0)) / 100).toFixed(2),
    },
    {
      key: "margin_percent",
      header: t("colMargin"),
      getValue: (p) => {
        if (p.price <= 0) return "0.00";
        return (((p.price - (p.cost_amount ?? 0)) / p.price) * 100).toFixed(2);
      },
    },
    { key: "in_stock", header: t("colStock"), getValue: (p) => p.in_stock },
    { key: "category", header: t("categoryLabel"), getValue: (p) => p.category ?? "" },
  ];

  const createMutation = useCrudMutation({
    mutationOptions: trpc.products.create.mutationOptions(),
    invalidateKeys,
    successMessage: t("created"),
    errorMessage: t("createFailed"),
    onSuccess: () => setIsDialogOpen(false),
  });

  const updateMutation = useCrudMutation({
    mutationOptions: trpc.products.update.mutationOptions(),
    invalidateKeys,
    successMessage: t("updated"),
    errorMessage: t("updateFailed"),
    onSuccess: () => setIsDialogOpen(false),
  });

  const deleteMutation = useCrudMutation({
    mutationOptions: trpc.products.delete.mutationOptions(),
    invalidateKeys,
    successMessage: t("deleted"),
    errorMessage: t("deleteFailed"),
  });

  const createCategoryMutation = useCrudMutation({
    mutationOptions: trpc.products.categories.create.mutationOptions(),
    invalidateKeys: categoriesKey,
    successMessage: t("categoryCreated"),
    errorMessage: t("categoryCreateFailed"),
  });

  const form = useForm({
    defaultValues: {
      name: "",
      description: "",
      price: 0,
      cost_amount: 0,
      in_stock: 0,
      category: "",
      image_url: "",
      image_urls: "",
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
        cost_amount: Math.round(value.cost_amount * 100),
        in_stock: value.in_stock,
        category: value.category || undefined,
        image_url: value.image_url || undefined,
        image_urls: parseImageUrlsInput(value.image_urls),
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
    setImageUploadError(null);
    setExtraImagesUploadError(null);
    setIsDropzoneActive(false);
    setIsExtraDropzoneActive(false);
    setNewCategoryName("");
    setIsCreatingCategory(false);
    form.reset();
    setIsDialogOpen(true);
  };

  const openEdit = (p: Product) => {
    setEditingId(p.id);
    setImageUploadError(null);
    setExtraImagesUploadError(null);
    setIsDropzoneActive(false);
    setIsExtraDropzoneActive(false);
    setNewCategoryName("");
    setIsCreatingCategory(false);
    form.reset();
    form.setFieldValue("name", p.name);
    form.setFieldValue("description", p.description ?? "");
    form.setFieldValue("price", p.price / 100);
    form.setFieldValue("in_stock", p.in_stock);
    form.setFieldValue("cost_amount", (p.cost_amount ?? 0) / 100);
    form.setFieldValue("category", p.category ?? "");
    form.setFieldValue("image_url", p.image_url ?? "");
    form.setFieldValue("image_urls", p.image_urls.join("\n"));
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

  const handleCreateCategory = (onSelectCategory: (value: string) => void) => {
    const normalizedName = newCategoryName.trim().replace(/\s+/g, " ");
    if (!normalizedName) return;
    createCategoryMutation.mutate(
      { name: normalizedName },
      {
        onSuccess: (createdCategory) => {
          setNewCategoryName("");
          setIsCreatingCategory(false);
          onSelectCategory(createdCategory.name);
        },
      },
    );
  };

  const validateImageFile = (file: File): string | null => {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.type)) {
      return "Formato no permitido. Usa PNG, JPG o WEBP.";
    }
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return "La imagen supera el límite de 5 MB.";
    }
    return null;
  };

  const uploadImage = async (file: File) => {
    const validationError = validateImageFile(file);
    if (validationError) {
      setImageUploadError(validationError);
      return;
    }

    setImageUploadError(null);
    setIsUploadingImage(true);
    try {
      const uploadBody = new FormData();
      uploadBody.append("file", file);

      const response = await fetch("/api/uploads/products", {
        method: "POST",
        body: uploadBody,
      });
      const data: { url?: string; error?: string } = await response.json();

      if (!response.ok || !data.url) {
        setImageUploadError(data.error ?? "No se pudo subir la imagen.");
        return;
      }

      form.setFieldValue("image_url", data.url);
    } catch {
      setImageUploadError("Error de red al subir la imagen.");
    } finally {
      setIsUploadingImage(false);
    }
  };

  const uploadExtraImages = async (files: FileList | File[]) => {
    const selectedFiles = Array.from(files);
    if (selectedFiles.length === 0) return;

    const validationError = selectedFiles
      .map(validateImageFile)
      .find((error): error is string => Boolean(error));

    if (validationError) {
      setExtraImagesUploadError(validationError);
      return;
    }

    const currentUrls = parseImageUrlsInput(form.getFieldValue("image_urls"));
    if (currentUrls.length + selectedFiles.length > MAX_EXTRA_IMAGES) {
      setExtraImagesUploadError(`Máximo ${MAX_EXTRA_IMAGES} imágenes adicionales.`);
      return;
    }

    setExtraImagesUploadError(null);
    setIsUploadingExtraImages(true);

    try {
      const uploadedUrls: string[] = [];
      for (const file of selectedFiles) {
        const uploadBody = new FormData();
        uploadBody.append("file", file);

        const response = await fetch("/api/uploads/products", {
          method: "POST",
          body: uploadBody,
        });
        const data: { url?: string; error?: string } = await response.json();

        if (!response.ok || !data.url) {
          setExtraImagesUploadError(data.error ?? "No se pudo subir una de las imágenes.");
          return;
        }

        uploadedUrls.push(data.url);
      }

      const merged = mergeUniqueUrls(form.getFieldValue("image_urls"), uploadedUrls);
      form.setFieldValue("image_urls", merged);
    } catch {
      setExtraImagesUploadError("Error de red al subir imágenes.");
    } finally {
      setIsUploadingExtraImages(false);
    }
  };

  const actionsColumn: Column<Product> = {
    key: "actions",
    header: tc("actions"),
    render: (row) => (
      <TableActions>
        <TableActionButton onClick={() => openEdit(row)} icon={<FilePenIcon className="w-4 h-4" />} label={tc("edit")} />
        <TableActionButton variant="danger" onClick={() => { setDeleteId(row.id); setIsDeleteOpen(true); }} icon={<TrashIcon className="w-4 h-4" />} label={tc("delete")} />
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
            searchPlaceholder={t("searchPlaceholder")}
            filters={[
              { options: kindFilterOptions, value: kindFilter, onChange: setKindFilter },
              { options: categoryFilterOptions, value: categoryFilter, onChange: setCategoryFilter },
              { options: stockFilterOptions, value: stockFilter, onChange: setStockFilter },
            ]}
          >
            <Button size="sm" onClick={openCreate}>
              <PlusIcon className="w-4 h-4 mr-2" />{t("addProduct")}
            </Button>
          </SearchFilter>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            data={filteredProducts}
            columns={[...columns, actionsColumn]}
            exportColumns={exportColumns}
            exportFilename="products"
            emptyMessage={t("empty")}
            emptyIcon={<PackageIcon className="w-8 h-8" />}
            defaultSort={[{ id: "name", desc: false }]}
          />
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) setIsDialogOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEditing ? t("editTitle") : t("createTitle")}</DialogTitle>
            <DialogDescription>{isEditing ? t("editSubtitle") : t("createSubtitle")}</DialogDescription>
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
                    <Label htmlFor="kind" className="sm:text-right">{t("kindLabel")}</Label>
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
                        <SelectItem value="product">{t("kindProduct")}</SelectItem>
                        <SelectItem value="service">{t("kindService")}</SelectItem>
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
                          <Label htmlFor="default_service_kind" className="sm:text-right">{t("serviceKindLabel")}</Label>
                          <div className="col-span-3">
                            <Select
                              value={field.state.value}
                              onValueChange={(v) => field.handleChange(v)}
                            >
                              <SelectTrigger><SelectValue placeholder={t("serviceKindPlaceholder")} /></SelectTrigger>
                              <SelectContent>
                                {SERVICE_KIND_OPTIONS.map((sk) => (
                                  <SelectItem key={sk} value={sk}>{tServiceKind(sk)}</SelectItem>
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
                    <Label htmlFor="name" className="sm:text-right">{t("nameLabel")}</Label>
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
                    <Label htmlFor="description" className="sm:text-right">{t("descriptionLabel")}</Label>
                    <Input id="description" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} className="col-span-3" />
                  </div>
                )}
              </form.Field>
              <form.Field name="price">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="price" className="sm:text-right">{t("priceLabel")}</Label>
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
                    <Label htmlFor="in_stock" className="sm:text-right">{t("inStockLabel")}</Label>
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
              <form.Field name="cost_amount">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="cost_amount" className="sm:text-right">{t("costLabel")}</Label>
                    <div className="col-span-3">
                      <Input
                        id="cost_amount"
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
              <form.Field name="category">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="category" className="sm:text-right">{t("categoryLabel")}</Label>
                    <div className="col-span-3 space-y-2">
                      <Select
                        value={field.state.value || undefined}
                        onValueChange={(value) => {
                          if (value === CREATE_CATEGORY_VALUE) {
                            setIsCreatingCategory(true);
                            setNewCategoryName("");
                            field.handleChange("");
                            return;
                          }
                          setIsCreatingCategory(false);
                          field.handleChange(value);
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder={t("selectCategory")} /></SelectTrigger>
                        <SelectContent>
                          {categoryOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                          ))}
                          <SelectItem value={CREATE_CATEGORY_VALUE}>{t("categoryCreateAction")}</SelectItem>
                        </SelectContent>
                      </Select>
                      {isCreatingCategory ? (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <Input
                            value={newCategoryName}
                            onChange={(event) => setNewCategoryName(event.target.value)}
                            placeholder={t("categoryNamePlaceholder")}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            disabled={createCategoryMutation.isPending || newCategoryName.trim().length === 0}
                            onClick={() => handleCreateCategory(field.handleChange)}
                          >
                            {t("categoryCreateButton")}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </form.Field>
              <form.Field name="image_url">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-start gap-2 sm:gap-4">
                    <Label htmlFor="image_url" className="sm:text-right">{t("imageUrlLabel")}</Label>
                    <div className="col-span-3 space-y-3">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => fileInputRef.current?.click()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            fileInputRef.current?.click();
                          }
                        }}
                        onDragEnter={(event) => {
                          event.preventDefault();
                          setIsDropzoneActive(true);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setIsDropzoneActive(true);
                        }}
                        onDragLeave={(event) => {
                          event.preventDefault();
                          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                            setIsDropzoneActive(false);
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          setIsDropzoneActive(false);
                          const file = event.dataTransfer.files?.[0];
                          if (file) {
                            void uploadImage(file);
                          }
                        }}
                        className={`rounded-md border border-dashed p-3 text-sm transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring ${
                          isDropzoneActive ? "border-primary bg-primary/5" : "border-muted-foreground/40"
                        }`}
                      >
                        <p className="font-medium">Arrastra y suelta una imagen aquí</p>
                        <p className="text-muted-foreground">O haz clic en Examinar. Formatos: PNG, JPG o WEBP (máx. 5 MB).</p>
                        <div className="mt-2 flex items-center gap-2">
                          <Button type="button" variant="outline" size="sm" disabled={isUploadingImage}>
                            {isUploadingImage ? "Subiendo..." : "Examinar"}
                          </Button>
                          {field.state.value ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={isUploadingImage}
                              onClick={(event) => {
                                event.stopPropagation();
                                field.handleChange("");
                                setImageUploadError(null);
                              }}
                            >
                              Quitar
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/jpg,image/webp"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) {
                            void uploadImage(file);
                          }
                          event.target.value = "";
                        }}
                      />
                      {imageUploadError ? <p className="text-xs text-destructive">{imageUploadError}</p> : null}
                      {field.state.value ? (
                        <div className="space-y-2">
                          <img
                            src={field.state.value}
                            alt="Vista previa de imagen"
                            className="h-28 w-28 rounded-md border object-cover"
                          />
                        </div>
                      ) : null}
                      <Input
                        id="image_url"
                        value={field.state.value}
                        onChange={(e) => {
                          field.handleChange(e.target.value);
                          setImageUploadError(null);
                        }}
                        placeholder="https://... o /uploads/products/..."
                      />
                    </div>
                  </div>
                )}
              </form.Field>
              <form.Field name="image_urls">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-start gap-2 sm:gap-4">
                    <Label htmlFor="image_urls" className="sm:text-right pt-2">{t("imageUrlsLabel")}</Label>
                    <div className="col-span-3 space-y-3">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => extraImagesInputRef.current?.click()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            extraImagesInputRef.current?.click();
                          }
                        }}
                        onDragEnter={(event) => {
                          event.preventDefault();
                          setIsExtraDropzoneActive(true);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setIsExtraDropzoneActive(true);
                        }}
                        onDragLeave={(event) => {
                          event.preventDefault();
                          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                            setIsExtraDropzoneActive(false);
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          setIsExtraDropzoneActive(false);
                          void uploadExtraImages(event.dataTransfer.files);
                        }}
                        className={`rounded-md border border-dashed p-3 text-sm transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring ${
                          isExtraDropzoneActive ? "border-primary bg-primary/5" : "border-muted-foreground/40"
                        }`}
                      >
                        <p className="font-medium">Arrastra y suelta imágenes adicionales aquí</p>
                        <p className="text-muted-foreground">O haz clic en Examinar. Formatos: PNG, JPG o WEBP (máx. 5 MB, hasta {MAX_EXTRA_IMAGES}).</p>
                        <div className="mt-2 flex items-center gap-2">
                          <Button type="button" variant="outline" size="sm" disabled={isUploadingExtraImages}>
                            {isUploadingExtraImages ? "Subiendo..." : "Examinar"}
                          </Button>
                        </div>
                      </div>
                      <input
                        ref={extraImagesInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/jpg,image/webp"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                          const files = event.target.files;
                          if (files) {
                            void uploadExtraImages(files);
                          }
                          event.target.value = "";
                        }}
                      />
                      {extraImagesUploadError ? <p className="text-xs text-destructive">{extraImagesUploadError}</p> : null}
                      {parseImageUrlsInput(field.state.value).length > 0 ? (
                        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                          {parseImageUrlsInput(field.state.value).map((url) => (
                            <div key={url} className="relative rounded-md border p-1">
                              <img
                                src={url}
                                alt="Vista previa de imagen adicional"
                                className="h-20 w-full rounded object-cover"
                              />
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="mt-1 w-full"
                                onClick={() => {
                                  const nextRaw = removeUrlFromRaw(field.state.value, url);
                                  field.handleChange(nextRaw);
                                  setExtraImagesUploadError(null);
                                }}
                              >
                                Quitar
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <Input id="image_urls" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} className="col-span-3" placeholder={t("imageUrlsPlaceholder")} />
                    </div>
                  </div>
                )}
              </form.Field>
            </div>
            <DialogFooter>
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <Button type="submit" disabled={isSubmitting || createMutation.isPending || updateMutation.isPending}>
                    {isEditing ? t("updateButton") : t("addButton")}
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} onConfirm={handleDelete} description={t("deleteConfirm")} />
    </>
  );
}
