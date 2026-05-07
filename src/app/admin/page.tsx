"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangleIcon,
  BanIcon,
  ChevronRightIcon,
  DollarSignIcon,
  HashIcon,
  MapPinIcon,
  WalletIcon,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useTRPC } from "@/lib/trpc/client";
import { useQuery } from "@tanstack/react-query";

type RangePreset = "today" | "week" | "month" | "custom";

function readActiveLocationCookie(): number | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/jeff_active_location_id=(\d+)/);
  return m ? Number(m[1]) : null;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(): Date {
  const d = startOfToday();
  const day = d.getDay();
  // Monday-based week (matches Jeff's operational week 11:00–21:00 L-D).
  const offset = (day + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

function startOfMonth(): Date {
  const d = startOfToday();
  d.setDate(1);
  return d;
}

function toInputValue(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function presetRange(preset: RangePreset): { from: Date; to: Date } {
  const to = new Date();
  switch (preset) {
    case "today":
      return { from: startOfToday(), to };
    case "week":
      return { from: startOfWeek(), to };
    case "month":
      return { from: startOfMonth(), to };
    default:
      return { from: startOfToday(), to };
  }
}

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const tc = useTranslations("common");
  const trpc = useTRPC();

  const { data: locations } = useQuery(trpc.locations.list.queryOptions());

  const [activeLocationId, setActiveLocationId] = useState<number | null>(null);
  useEffect(() => {
    setActiveLocationId(readActiveLocationCookie());
  }, []);

  const [preset, setPreset] = useState<RangePreset>("today");
  const initialRange = presetRange("today");
  const [from, setFrom] = useState<Date>(initialRange.from);
  const [to, setTo] = useState<Date>(initialRange.to);

  const applyPreset = (p: RangePreset) => {
    setPreset(p);
    if (p !== "custom") {
      const r = presetRange(p);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  const queryInput = useMemo(
    () => ({
      locationId: activeLocationId ?? undefined,
      rangeFrom: from,
      rangeTo: to,
    }),
    [activeLocationId, from, to],
  );

  const { data, isLoading } = useQuery(
    trpc.dashboard.stats.queryOptions(queryInput),
  );

  const activeLocationName = useMemo(() => {
    if (!locations || activeLocationId == null) return null;
    return locations.find((l) => l.id === activeLocationId)?.name ?? null;
  }, [locations, activeLocationId]);

  if (isLoading || !data) {
    return <DashboardSkeleton />;
  }

  const STATUS_PILL: Record<
    "open" | "closed" | "none",
    { label: string; variant: Parameters<typeof Badge>[0]["variant"] }
  > = {
    open: { label: t("cashOpen"), variant: "income" },
    closed: { label: t("cashClosed"), variant: "secondary" },
    none: { label: t("noCash"), variant: "destructive" },
  };
  const pill = STATUS_PILL[data.cashSession.status];

  return (
    <div className="grid flex-1 items-start gap-6 min-w-0">
      {/* Header */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <MapPinIcon className="h-4 w-4" />
              <span>{activeLocationName ?? t("allLocations")}</span>
            </div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{data.business.name}</h1>
              <Badge variant={pill.variant}>{pill.label}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RangePresetButtons active={preset} onChange={applyPreset} />
            <RangeInputs
              from={from}
              to={to}
              onFromChange={(d) => {
                setPreset("custom");
                setFrom(d);
              }}
              onToChange={(d) => {
                setPreset("custom");
                setTo(d);
              }}
            />
            {data.cashSession.status === "none" && activeLocationId != null && (
              <Button asChild size="sm">
                <a href="/admin/cashier">{t("openCash")}</a>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Guía rápida por sección</CardTitle>
          <CardDescription>
            Atajos del sidebar con una referencia breve para el turno actual.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/20 p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Flujo recomendado de apertura</h3>
              <Badge variant="secondary">Inicio de turno</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              1) Selecciona el local activo. 2) Abre caja. 3) Registra ventas en Sanctum Desk.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[
              {
                title: "Panel",
                hint: "Resumen operativo de ventas, caja y alertas de stock.",
                href: "/admin",
                cta: "Ver panel",
              },
              {
                title: "Caja",
                hint: "Abre o cierra turno y valida efectivo esperado contra contado.",
                href: "/admin/cashier",
                cta: "Ir a Caja",
              },
              {
                title: "Sanctum Desk",
                hint: "Busca productos o servicios, arma carrito y confirma venta.",
                href: "/admin/pos",
                cta: "Ir a Sanctum Desk",
              },
              {
                title: "Inventario",
                hint: "Consulta existencias, ajusta stock y transfiere entre locales.",
                href: "/admin/inventory",
                cta: "Ver inventario",
              },
              {
                title: "Ventas",
                hint: "Revisa historial de órdenes, filtros y estado de anulaciones.",
                href: "/admin/orders",
                cta: "Ver ventas",
              },
              {
                title: "Clientes",
                hint: "Administra clientes para asociar ventas y facilitar seguimiento.",
                href: "/admin/customers",
                cta: "Ver clientes",
              },
            ].map((item) => (
              <div key={item.href} className="rounded-lg border p-3">
                <p className="text-sm font-semibold">{item.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p>
                <Button asChild size="sm" variant="ghost" className="mt-3 px-0">
                  <a href={item.href}>
                    {item.cta} <ChevronRightIcon className="ml-1 h-4 w-4" />
                  </a>
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Sales KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          icon={<DollarSignIcon className="h-4 w-4" />}
          title={t("kpiSalesRevenue")}
          value={formatCurrency(data.sales.todayRevenue)}
          hint={t("kpiSalesRevenueHint", { count: data.sales.todayCount })}
        />
        <Kpi
          icon={<HashIcon className="h-4 w-4" />}
          title={t("kpiSalesCount")}
          value={String(data.sales.todayCount)}
          hint={t("kpiSalesCountHint")}
        />
        <Kpi
          icon={<BanIcon className="h-4 w-4" />}
          title={t("kpiVoidedRevenue")}
          value={formatCurrency(data.sales.voidedRevenue)}
          hint={t("kpiVoidedRevenueHint", { count: data.sales.voidedCount })}
          tone="warn"
        />
        <Kpi
          icon={<HashIcon className="h-4 w-4" />}
          title={t("kpiVoidedCount")}
          value={String(data.sales.voidedCount)}
          hint={t("kpiVoidedCountHint")}
          tone="warn"
        />
      </div>

      {/* Cash session */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi
          icon={<WalletIcon className="h-4 w-4" />}
          title={t("kpiExpectedCash")}
          value={formatCurrency(data.cashSession.expectedCash)}
          hint={
            data.cashSession.status === "none"
              ? t("kpiExpectedCashHintNoSession")
              : t("kpiExpectedCashHintActive")
          }
        />
        <Kpi
          icon={<WalletIcon className="h-4 w-4" />}
          title={t("kpiExpectedDigital")}
          value={formatCurrency(data.cashSession.expectedDigital)}
          hint={t("kpiExpectedDigitalHint")}
        />
        <Kpi
          icon={<WalletIcon className="h-4 w-4" />}
          title={t("kpiDifference")}
          value={
            data.cashSession.difference == null
              ? "—"
              : formatCurrency(data.cashSession.difference)
          }
          hint={
            data.cashSession.status === "closed"
              ? t("kpiDifferenceHintClosed")
              : t("kpiDifferenceHintOpen")
          }
          tone={
            data.cashSession.difference == null
              ? "neutral"
              : data.cashSession.difference === 0
                ? "neutral"
                : "warn"
          }
        />
      </div>

      {/* Sales by payment method + Low stock */}
      <div className="grid gap-6 lg:grid-cols-2 min-w-0">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t("salesByMethod")}</CardTitle>
            <CardDescription>{t("salesByMethodSubtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            {data.sales.byPaymentMethod.length === 0 ? (
              <EmptyMessage message={t("salesByMethodEmpty")} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("method")}</TableHead>
                    <TableHead className="text-right">{tc("total")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.sales.byPaymentMethod.map((row) => (
                    <TableRow key={row.paymentMethodId}>
                      <TableCell>{row.name}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(row.total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{t("lowStock")}</CardTitle>
                <CardDescription>{t("lowStockSubtitle")}</CardDescription>
              </div>
              {data.inventory.lowStockCount > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangleIcon className="h-3 w-3" />
                  {data.inventory.lowStockCount}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {data.inventory.lowStock.length === 0 ? (
              <EmptyMessage message={t("lowStockEmpty")} />
            ) : (
              <LowStockTable rows={data.inventory.lowStock} />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {t("monthExpenses")}
          </span>{" "}
          {formatCurrency(data.expensesPlaceholder.monthTotal)} —{" "}
          {data.expensesPlaceholder.note}
        </CardContent>
      </Card>
    </div>
  );
}

function LowStockTable({
  rows,
}: {
  rows: { productId: number; productName: string; locationId: number; locationName: string; quantityOnHand: number }[];
}) {
  const t = useTranslations("dashboard");
  const tc = useTranslations("common");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("product")}</TableHead>
          <TableHead>{tc("location")}</TableHead>
          <TableHead className="text-right">{t("remaining")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.productId}-${row.locationId}`}>
            <TableCell>{row.productName}</TableCell>
            <TableCell className="text-muted-foreground">
              {row.locationName}
            </TableCell>
            <TableCell className="text-right font-semibold text-red-600">
              {row.quantityOnHand}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Kpi({
  icon,
  title,
  value,
  hint,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "warn";
}) {
  const valueClass =
    tone === "warn" ? "text-amber-600" : "text-foreground";
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${valueClass}`}>{value}</div>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function RangePresetButtons({
  active,
  onChange,
}: {
  active: RangePreset;
  onChange: (p: RangePreset) => void;
}) {
  const t = useTranslations("dashboard");
  const items: { id: RangePreset; label: string }[] = [
    { id: "today", label: t("rangeToday") },
    { id: "week", label: t("rangeWeek") },
    { id: "month", label: t("rangeMonth") },
  ];
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5">
      {items.map((item) => (
        <Button
          key={item.id}
          size="sm"
          variant={active === item.id ? "default" : "ghost"}
          className="h-7 px-3 text-xs"
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}

function RangeInputs({
  from,
  to,
  onFromChange,
  onToChange,
}: {
  from: Date;
  to: Date;
  onFromChange: (d: Date) => void;
  onToChange: (d: Date) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Input
        type="date"
        value={toInputValue(from)}
        onChange={(e) => {
          const v = e.target.value;
          if (v) onFromChange(new Date(`${v}T00:00:00`));
        }}
        className="h-8 w-[140px]"
      />
      <span className="text-muted-foreground text-xs">→</span>
      <Input
        type="date"
        value={toInputValue(to)}
        onChange={(e) => {
          const v = e.target.value;
          if (v) onToChange(new Date(`${v}T23:59:59`));
        }}
        className="h-8 w-[140px]"
      />
    </div>
  );
}

function EmptyMessage({ message }: { message: string }) {
  return (
    <div className="flex h-[120px] items-center justify-center">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid flex-1 items-start gap-6">
      <Card>
        <CardContent className="p-6">
          <Skeleton className="h-10 w-2/3" />
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-28 mb-2" />
              <Skeleton className="h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-[200px] w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
