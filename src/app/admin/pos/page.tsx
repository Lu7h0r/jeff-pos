"use client";

import React, { useState, useMemo, useEffect } from "react";
import { useTranslations } from "next-intl";
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
  CheckIcon,
  PlusIcon,
  ScissorsIcon,
  SearchIcon,
  Trash2Icon,
  UserIcon,
  PackageIcon,
  WalletIcon,
  HandCoinsIcon,
  ArrowRightLeftIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
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
  imageUrl: string | null;
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

type QuickServiceForm = {
  artistId: string;
  serviceKind: ServiceKind;
  serviceName: string;
  totalAgreedAmount: string;
  initialPayment: string;
  paymentMethodId: string;
  notes: string;
};

type PosSessionForm = {
  scheduledFor: string;
  artistId: string;
  sessionAmount: string;
  notes: string;
};

type AgreementMediaKind = "before" | "after" | "reference" | "consent";

type AgreementMediaForm = {
  sessionId: string;
  mediaUrl: string;
  mediaKind: AgreementMediaKind;
  caption: string;
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
  const t = useTranslations("pos");
  const tc = useTranslations("common");
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
          t("orderCreated", {
            id: order.id,
            amount: formatCurrency(order.total_amount),
          }),
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
              t("serviceAttachFailed", {
                item: String(intent.orderItemId),
                error: e instanceof Error ? e.message : t("unknownError"),
              }),
            );
          }
        }

        setCart([]);
        setSelectedCustomerId(null);
        setPaymentLines([{ paymentMethodId: null, amount: 0 }]);
      },
      onError: (err) => toast.error(err.message || t("createOrderError")),
    }),
  );

  const createServiceAgreementMutation = useMutation(
    trpc.serviceAgreements.create.mutationOptions(),
  );

  const addServiceAgreementPaymentMutation = useMutation(
    trpc.serviceAgreements.addPayment.mutationOptions(),
  );
  const agreementsQuery = useQuery({
    ...trpc.serviceAgreements.list.queryOptions({ locationId: locationId ?? 0 }),
    enabled: locationId != null && sessionQuery.data != null,
  });

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
  const [quickServiceOpen, setQuickServiceOpen] = useState(false);
  const [quickServiceForm, setQuickServiceForm] = useState<QuickServiceForm>({
    artistId: "",
    serviceKind: "tattoo",
    serviceName: "",
    totalAgreedAmount: "",
    initialPayment: "",
    paymentMethodId: "",
    notes: "",
  });
  const [quickServiceErrors, setQuickServiceErrors] = useState<
    Partial<Record<keyof QuickServiceForm, string>>
  >({});
  const [quickServiceSubmitting, setQuickServiceSubmitting] = useState(false);
  const [lastCreatedAgreement, setLastCreatedAgreement] = useState<{
    id: number;
    serviceName: string;
    totalAgreedAmount: number;
    totalPaidAmount: number;
    pendingAmount: number;
  } | null>(null);
  const [selectedAgreementId, setSelectedAgreementId] = useState<number | null>(null);
  const [sessionForm, setSessionForm] = useState<PosSessionForm>({
    scheduledFor: "",
    artistId: "",
    sessionAmount: "",
    notes: "",
  });
  const [sessionFormError, setSessionFormError] = useState<string | null>(null);
  const [mediaForm, setMediaForm] = useState<AgreementMediaForm>({
    sessionId: "",
    mediaUrl: "",
    mediaKind: "reference",
    caption: "",
  });

  const sessionsQuery = useQuery({
    ...trpc.serviceAgreements.listSessions.queryOptions({
      agreementId: selectedAgreementId ?? 0,
    }),
    enabled: selectedAgreementId != null,
  });

  const mediaQuery = useQuery({
    ...trpc.serviceAgreements.listMedia.queryOptions({
      agreementId: selectedAgreementId ?? 0,
    }),
    enabled: selectedAgreementId != null,
  });

  const outboxEventsQuery = useQuery({
    ...trpc.serviceAgreements.listOutboxEvents.queryOptions({
      status: "pending",
      limit: 50,
    }),
    enabled: locationId != null && sessionQuery.data != null,
  });

  const checkFollowUpEvent = async (input: {
    agreementId: number;
    sessionId?: number;
    eventType: "service_session_followup" | "service_payment_followup";
  }) => {
    const latest = await queryClient.fetchQuery(
      trpc.serviceAgreements.listOutboxEvents.queryOptions({
        status: "pending",
        limit: 50,
      }),
    );

    return latest.find((event) => {
      if (event.service_agreement_id !== input.agreementId) return false;
      if (event.event_type !== input.eventType) return false;
      if (
        input.sessionId !== undefined &&
        event.service_agreement_session_id !== input.sessionId
      ) {
        return false;
      }
      return true;
    });
  };

  const createSessionMutation = useMutation(
    trpc.serviceAgreements.createSession.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries(
          trpc.serviceAgreements.listSessions.queryOptions({
            agreementId: selectedAgreementId ?? 0,
          }),
        );
        setSessionForm({
          scheduledFor: "",
          artistId: "",
          sessionAmount: "",
          notes: "",
        });
        setSessionFormError(null);
        toast.success(t("sessionCreated"));
        const hasFollowup = await checkFollowUpEvent({
          agreementId: result.session.service_agreement_id,
          sessionId: result.session.id,
          eventType: "service_session_followup",
        });
        if (hasFollowup) {
          toast.success(t("followupEnqueuedSession"));
        }
      },
      onError: (err) => {
        toast.error(err.message || t("sessionCreateError"));
      },
    }),
  );

  const updateSessionStatusMutation = useMutation(
    trpc.serviceAgreements.updateSessionStatus.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(
          trpc.serviceAgreements.listSessions.queryOptions({
            agreementId: selectedAgreementId ?? 0,
          }),
        );
        toast.success(t("sessionCompleted"));
      },
      onError: (err) => {
        toast.error(err.message || t("sessionStatusError"));
      },
    }),
  );

  const attachAgreementMediaMutation = useMutation(
    trpc.serviceAgreements.attachMedia.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(
          trpc.serviceAgreements.listMedia.queryOptions({
            agreementId: selectedAgreementId ?? 0,
          }),
        );
        setMediaForm((prev) => ({
          ...prev,
          mediaUrl: "",
          caption: "",
        }));
        toast.success(t("agreementMediaAttachSuccess"));
      },
      onError: (err) => {
        toast.error(err.message || t("agreementMediaAttachError"));
      },
    }),
  );

  const tServiceKind = (k: ServiceKind) => t(`serviceKinds.${k}`);

  const selectedAgreement = useMemo(() => {
    if (selectedAgreementId == null) return null;
    return (agreementsQuery.data ?? []).find((a) => a.id === selectedAgreementId) ?? null;
  }, [agreementsQuery.data, selectedAgreementId]);

  const selectedAgreementCustomer = useMemo(() => {
    if (selectedAgreement?.customer_id == null) return null;
    return (
      (customersQuery.data ?? []).find(
        (customer) => customer.id === selectedAgreement.customer_id,
      ) ?? null
    );
  }, [customersQuery.data, selectedAgreement]);

  const customerConsentQuery = useQuery({
    ...trpc.serviceAgreements.getCustomerConsent.queryOptions({
      customerId: selectedAgreement?.customer_id ?? 0,
    }),
    enabled: selectedAgreement?.customer_id != null,
  });

  const upsertConsentMutation = useMutation(
    trpc.serviceAgreements.upsertCustomerConsent.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries(
          trpc.serviceAgreements.getCustomerConsent.queryOptions({
            customerId: selectedAgreement?.customer_id ?? 0,
          }),
        );
        toast.success(t("consentUpdateSuccess"));
      },
      onError: (err) => {
        toast.error(err.message || t("consentUpdateError"));
      },
    }),
  );

  useEffect(() => {
    if (lastCreatedAgreement) {
      setSelectedAgreementId(lastCreatedAgreement.id);
      return;
    }
    if (selectedAgreementId != null) return;
    const first = agreementsQuery.data?.[0];
    if (first) {
      setSelectedAgreementId(first.id);
    }
  }, [agreementsQuery.data, lastCreatedAgreement, selectedAgreementId]);

  const formatDateTimeForInput = (date: Date) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  };

  const scheduleNow = () => {
    setSessionForm((prev) => ({
      ...prev,
      scheduledFor: formatDateTimeForInput(new Date()),
    }));
  };

  const createSessionFromPos = () => {
    if (selectedAgreementId == null) {
      setSessionFormError(t("sessionValidationAgreement"));
      return;
    }
    const scheduledDate = new Date(sessionForm.scheduledFor);
    if (!sessionForm.scheduledFor || Number.isNaN(scheduledDate.getTime())) {
      setSessionFormError(t("sessionValidationDate"));
      return;
    }
    if (!sessionForm.artistId) {
      setSessionFormError(t("sessionValidationArtist"));
      return;
    }
    const parsedAmount = Math.floor(Number(sessionForm.sessionAmount) || 0);
    if (parsedAmount < 0) {
      setSessionFormError(t("sessionValidationAmount"));
      return;
    }
    setSessionFormError(null);
    createSessionMutation.mutate({
      agreementId: selectedAgreementId,
      staffMemberId: Number(sessionForm.artistId),
      scheduledFor: scheduledDate,
      sessionAmount: parsedAmount,
      notes: sessionForm.notes.trim() || undefined,
    });
  };

  const markSessionCompleted = (sessionId: number) => {
    updateSessionStatusMutation.mutate({ sessionId, status: "completed" });
  };

  const submitAgreementMedia = () => {
    if (selectedAgreementId == null) {
      toast.error(t("agreementMediaValidationAgreement"));
      return;
    }
    if (!mediaForm.mediaUrl.trim()) {
      toast.error(t("agreementMediaValidationUrl"));
      return;
    }

    attachAgreementMediaMutation.mutate({
      agreementId: selectedAgreementId,
      sessionId: mediaForm.sessionId ? Number(mediaForm.sessionId) : undefined,
      mediaUrl: mediaForm.mediaUrl.trim(),
      mediaKind: mediaForm.mediaKind,
      caption: mediaForm.caption.trim() || undefined,
    });
  };

  const updateWhatsAppConsent = (status: "granted" | "revoked") => {
    if (selectedAgreement?.customer_id == null) {
      toast.error(t("consentNoCustomer"));
      return;
    }

    upsertConsentMutation.mutate({
      customerId: selectedAgreement.customer_id,
      locationId: locationId ?? undefined,
      status,
      source: "pos",
      notes: t("consentSourcePos"),
    });
  };

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
          imageUrl: product?.image_url ?? product?.image_urls?.[0] ?? null,
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
        imageUrl: p.image_url ?? p.image_urls?.[0] ?? null,
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
  const pendingAmount = Math.max(0, total - paymentsTotal);
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
      toast.error(t("outOfStock", { name: item.name }));
      return;
    }
    setCart((prev) => {
      const existing = prev.find((c) => c.productId === item.productId);
      if (existing) {
        if (existing.quantity >= item.onHand) {
          toast.error(t("onlyAvailable", { count: item.onHand }));
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
          toast.error(t("onlyAvailable", { count: c.onHand }));
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
      toast.error(t("pickStaff"));
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

  const fillSinglePaymentWithTotal = () => {
    setPaymentLines((prev) => {
      const current = prev[0] ?? { paymentMethodId: null, amount: 0 };
      return [{ ...current, amount: total }];
    });
  };

  const fillPendingInLastLine = () => {
    setPaymentLines((prev) => {
      if (prev.length === 0) return [{ paymentMethodId: null, amount: pendingAmount }];
      const next = [...prev];
      const lastIndex = next.length - 1;
      next[lastIndex] = { ...next[lastIndex], amount: pendingAmount };
      return next;
    });
  };

  const splitPaymentsEvenly = () => {
    setPaymentLines((prev) => {
      if (prev.length === 0 || total <= 0) return prev;
      const perLine = Math.floor(total / prev.length);
      let remainder = total - perLine * prev.length;
      return prev.map((line) => {
        const extra = remainder > 0 ? 1 : 0;
        remainder -= extra;
        return { ...line, amount: perLine + extra };
      });
    });
  };

  const handleCreate = () => {
    if (!canCreate) return;
    if (unassignedServiceCount > 0) {
      toast.warning(t("unassignedToast", { count: unassignedServiceCount }));
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
          <CardTitle>{t("unavailableTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">{t("unavailableHint")}</p>
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
          <CardTitle>{t("noSessionTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("noSessionHint")}</p>
          <Link
            href="/admin/cashier"
            className="inline-flex items-center text-primary underline"
          >
            {t("goToCashier")}
          </Link>
        </CardContent>
      </Card>
    );
  }

  const customers = customersQuery.data ?? [];
  const paymentMethods = paymentMethodsQuery.data ?? [];
  const selectedCustomer =
    selectedCustomerId == null
      ? null
      : customers.find((c) => c.id === selectedCustomerId) ?? null;

  const openQuickServiceModal = () => {
    setQuickServiceErrors({});
    setQuickServiceForm((prev) => ({
      ...prev,
      artistId: "",
      serviceKind: "tattoo",
      serviceName: "",
      totalAgreedAmount: "",
      initialPayment: "",
      paymentMethodId: "",
      notes: "",
    }));
    setQuickServiceOpen(true);
  };

  const confirmQuickService = async () => {
    const nextErrors: Partial<Record<keyof QuickServiceForm, string>> = {};
    const totalAgreedAmount = Math.floor(Number(quickServiceForm.totalAgreedAmount) || 0);
    const initialPayment = Math.floor(Number(quickServiceForm.initialPayment) || 0);

    if (!quickServiceForm.artistId) {
      nextErrors.artistId = t("quickServiceValidationArtist");
    }
    if (!quickServiceForm.serviceName.trim()) {
      nextErrors.serviceName = t("quickServiceValidationName");
    }
    if (totalAgreedAmount <= 0) {
      nextErrors.totalAgreedAmount = t("quickServiceValidationTotal");
    }
    if (initialPayment < 0) {
      nextErrors.initialPayment = t("quickServiceValidationInitial");
    }
    if (initialPayment > totalAgreedAmount && totalAgreedAmount > 0) {
      nextErrors.initialPayment = t("quickServiceValidationInitialExceeds");
    }
    if (initialPayment > 0 && !quickServiceForm.paymentMethodId) {
      nextErrors.paymentMethodId = t("quickServiceValidationPaymentMethod");
    }

    if (Object.keys(nextErrors).length > 0) {
      setQuickServiceErrors(nextErrors);
      return;
    }

    setQuickServiceErrors({});
    setQuickServiceSubmitting(true);

    try {
      const artist = (staffQuery.data ?? []).find(
        (s) => s.id === Number(quickServiceForm.artistId),
      );
      const serviceName = quickServiceForm.serviceName.trim();
      const composedNotes = [
        quickServiceForm.notes.trim(),
        `${t("serviceKindLabel")}: ${tServiceKind(quickServiceForm.serviceKind)}`,
        artist ? `${t("staff")}: ${artist.display_name}` : null,
      ]
        .filter((part): part is string => !!part)
        .join(" | ");

      const created = await createServiceAgreementMutation.mutateAsync({
        locationId: locationId!,
        customerId: selectedCustomerId ?? undefined,
        serviceName,
        totalAgreedAmount,
        notes: composedNotes || undefined,
      });

      const withPayment =
        initialPayment > 0
          ? await addServiceAgreementPaymentMutation.mutateAsync({
              agreementId: created.id,
              paymentLines: [
                {
                  paymentMethodId: Number(quickServiceForm.paymentMethodId),
                  amount: initialPayment,
                },
              ],
              notes: t("quickServiceInitialPaymentNote"),
            })
          : null;

      if (withPayment) {
        const hasFollowup = await checkFollowUpEvent({
          agreementId: withPayment.id,
          eventType: "service_payment_followup",
        });
        if (hasFollowup) {
          toast.success(t("followupEnqueuedPayment"));
        }
      }

      const totals = withPayment ?? created;
      setLastCreatedAgreement({
        id: totals.id,
        serviceName: created.service_name,
        totalAgreedAmount: totals.total_agreed_amount,
        totalPaidAmount: totals.total_paid_amount,
        pendingAmount: totals.pending_amount,
      });
      setSelectedAgreementId(created.id);
      setQuickServiceOpen(false);
      toast.success(t("quickServiceCreated", { id: created.id }));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("quickServiceCreateError"),
      );
    } finally {
      setQuickServiceSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-7xl mx-auto grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
      <Card>
        <CardHeader>
          <CardTitle>{t("catalogue")}</CardTitle>
          <div className="relative !mt-4">
            <SearchIcon className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder={t("searchPlaceholder")}
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
                  ? `🪡 ${c.name} ${t("serviceBadgeInline")}`
                  : `${c.name} (${c.onHand})`,
            }))}
            placeholder={t("addToCart")}
            noSelect
            onSelect={(id) => handleAddCatalogueItem(Number(id))}
          />
          <div className="mt-3 max-h-[65vh] overflow-y-auto text-sm space-y-5 pr-1">
            {groupedCatalogue.services.length > 0 ? (
              <section>
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  <ScissorsIcon className="h-3.5 w-3.5" /> {t("services")}
                </h3>
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {groupedCatalogue.services.map((c) => (
                    <li
                      key={`svc-${c.productId}`}
                      className="h-full"
                    >
                      <button
                        type="button"
                        onClick={() => handleAddCatalogueItem(c.productId)}
                        className={`w-full h-full rounded-lg border p-3 text-left transition hover:border-primary/60 hover:bg-muted/30 ${
                          cart.some((item) => item.productId === c.productId)
                            ? "border-primary bg-primary/5"
                            : ""
                        }`}
                      >
                        <div className="mb-3 overflow-hidden rounded-md border bg-muted/20">
                          {c.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={c.imageUrl}
                              alt={`Imagen de ${c.name}`}
                              className="h-24 w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="flex h-24 w-full items-center justify-center text-muted-foreground">
                              <ScissorsIcon className="h-5 w-5" />
                            </div>
                          )}
                        </div>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-medium leading-tight">{c.name}</p>
                            {c.defaultServiceKind ? (
                              <p className="text-xs text-muted-foreground mt-1">
                                {tServiceKind(c.defaultServiceKind)}
                              </p>
                            ) : null}
                          </div>
                          {cart.some((item) => item.productId === c.productId) ? (
                            <CheckIcon className="h-4 w-4 text-primary shrink-0" />
                          ) : null}
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <Badge variant="default">{t("serviceBadge")}</Badge>
                          <span className="font-semibold">{formatCurrency(c.unitPrice)}</span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {groupedCatalogue.products.length > 0 ? (
              <section>
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  <PackageIcon className="h-3.5 w-3.5" /> {t("products")}
                </h3>
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {groupedCatalogue.products.map((c) => (
                    <li
                      key={`prod-${c.productId}`}
                      className="h-full"
                    >
                      <button
                        type="button"
                        onClick={() => handleAddCatalogueItem(c.productId)}
                        className={`w-full h-full rounded-lg border p-3 text-left transition hover:border-primary/60 hover:bg-muted/30 ${
                          cart.some((item) => item.productId === c.productId)
                            ? "border-primary bg-primary/5"
                            : ""
                        }`}
                      >
                        <div className="mb-3 overflow-hidden rounded-md border bg-muted/20">
                          {c.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={c.imageUrl}
                              alt={`Imagen de ${c.name}`}
                              className="h-24 w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="flex h-24 w-full items-center justify-center text-muted-foreground">
                              <PackageIcon className="h-5 w-5" />
                            </div>
                          )}
                        </div>
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-medium leading-tight">{c.name}</p>
                          {cart.some((item) => item.productId === c.productId) ? (
                            <CheckIcon className="h-4 w-4 text-primary shrink-0" />
                          ) : null}
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <Badge
                            variant={c.onHand > 5 ? "secondary" : "destructive"}
                          >
                            {t("onHand", { count: c.onHand })}
                          </Badge>
                          <span className="font-semibold">{formatCurrency(c.unitPrice)}</span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {filteredCatalogue.length === 0 ? (
              <p className="text-muted-foreground">{t("emptyCatalogue")}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4 xl:sticky xl:top-20">
        <Card>
          <CardHeader>
            <CardTitle>{t("cart")}</CardTitle>
            <div className="!mt-4">
              <Combobox
                items={customers}
                placeholder={t("walkIn")}
                onSelect={(id) => setSelectedCustomerId(Number(id))}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="!mt-3 justify-start"
              onClick={openQuickServiceModal}
            >
              <PlusIcon className="mr-2 h-3.5 w-3.5" />
              {t("quickServiceAction")}
            </Button>
          </CardHeader>
          <CardContent>
            {cart.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("emptyCart")}</p>
            ) : (
              <div className="space-y-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("item")}</TableHead>
                      <TableHead>{tc("qty")}</TableHead>
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
                                  {t("serviceBadge")}
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
                                    {t("artistLabel")}{" "}
                                    <strong>{c.service.staffDisplayName}</strong>
                                    <span className="text-muted-foreground">
                                      · {tServiceKind(c.service.serviceKind)}
                                      {c.service.bodyLocation
                                        ? ` · ${c.service.bodyLocation}`
                                        : ""}
                                    </span>
                                  </span>
                                  <span className="text-muted-foreground underline">
                                    {t("editArtist")}
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
                                    {t("assignArtist")}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {tc("required")}
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
                    {t("unassignedHint", { count: unassignedServiceCount })}
                  </p>
                ) : null}
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              {t("pricesNote")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>{t("financialSummary")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {lastCreatedAgreement ? (
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
                <p className="text-xs font-medium text-emerald-700">
                  {t("quickServiceSummaryTitle", { id: lastCreatedAgreement.id })}
                </p>
                <p className="text-sm">{lastCreatedAgreement.serviceName}</p>
                <div className="mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-3">
                  <span>
                    {t("agreedTotal")}: {formatCurrency(lastCreatedAgreement.totalAgreedAmount)}
                  </span>
                  <span>
                    {t("paidTotal")}: {formatCurrency(lastCreatedAgreement.totalPaidAmount)}
                  </span>
                  <span>
                    {t("pendingTotal")}: {formatCurrency(lastCreatedAgreement.pendingAmount)}
                  </span>
                </div>
              </div>
            ) : null}
            <div className="flex items-center justify-between rounded-md border p-2">
              <span className="text-sm text-muted-foreground">{t("agreedTotal")}</span>
              <strong>{formatCurrency(total)}</strong>
            </div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <span className="text-sm text-muted-foreground">{t("paidTotal")}</span>
              <strong>{formatCurrency(paymentsTotal)}</strong>
            </div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <span className="text-sm text-muted-foreground">{t("pendingTotal")}</span>
              <strong className={pendingAmount > 0 ? "text-amber-700" : ""}>
                {formatCurrency(pendingAmount)}
              </strong>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-1 gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={fillSinglePaymentWithTotal}
                disabled={total <= 0}
                className="justify-start"
              >
                <WalletIcon className="mr-2 h-3.5 w-3.5" />
                {t("quickCollectTotal")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={fillPendingInLastLine}
                disabled={pendingAmount <= 0}
                className="justify-start"
              >
                <HandCoinsIcon className="mr-2 h-3.5 w-3.5" />
                {t("quickCollectPending")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={splitPaymentsEvenly}
                disabled={paymentLines.length < 2 || total <= 0}
                className="justify-start"
              >
                <ArrowRightLeftIcon className="mr-2 h-3.5 w-3.5" />
                {t("quickSplitPayment")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("sessionsPanelTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-1">
              <Label>{t("sessionsAgreementLabel")}</Label>
              <Select
                value={selectedAgreementId != null ? String(selectedAgreementId) : ""}
                onValueChange={(value) => setSelectedAgreementId(Number(value))}
                disabled={(agreementsQuery.data ?? []).length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("sessionsAgreementPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {(agreementsQuery.data ?? []).map((agreement) => (
                    <SelectItem key={agreement.id} value={String(agreement.id)}>
                      #{agreement.id} · {agreement.service_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedAgreement ? (
              <div className="rounded-md border p-2 text-xs text-muted-foreground">
                <p>
                  {t("agreedTotal")}: {formatCurrency(selectedAgreement.total_agreed_amount)}
                </p>
                <p>
                  {t("pendingTotal")}: {formatCurrency(selectedAgreement.pending_amount)}
                </p>
              </div>
            ) : null}

            <div className="rounded-md border p-3 space-y-2">
              <p className="text-sm font-medium">{t("sessionsCreateTitle")}</p>
              <div className="grid gap-1">
                <Label>{t("sessionsDateLabel")}</Label>
                <Input
                  type="datetime-local"
                  value={sessionForm.scheduledFor}
                  onChange={(e) =>
                    setSessionForm((prev) => ({ ...prev, scheduledFor: e.target.value }))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-start px-0"
                  onClick={scheduleNow}
                >
                  {t("sessionsUseNow")}
                </Button>
              </div>
              <div className="grid gap-1">
                <Label>{t("staff")}</Label>
                <Select
                  value={sessionForm.artistId}
                  onValueChange={(value) =>
                    setSessionForm((prev) => ({ ...prev, artistId: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("pickStaffMember")} />
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
              <div className="grid gap-1">
                <Label>{t("sessionsAmountLabel")}</Label>
                <Input
                  type="number"
                  min={0}
                  value={sessionForm.sessionAmount}
                  onChange={(e) =>
                    setSessionForm((prev) => ({ ...prev, sessionAmount: e.target.value }))
                  }
                  placeholder="0"
                />
              </div>
              <div className="grid gap-1">
                <Label>{tc("notes")}</Label>
                <Input
                  value={sessionForm.notes}
                  onChange={(e) =>
                    setSessionForm((prev) => ({ ...prev, notes: e.target.value }))
                  }
                  placeholder={t("sessionsNotesPlaceholder")}
                />
              </div>
              {sessionFormError ? (
                <p className="text-xs text-destructive">{sessionFormError}</p>
              ) : null}
              <Button
                type="button"
                onClick={createSessionFromPos}
                disabled={createSessionMutation.isPending || selectedAgreementId == null}
                className="w-full"
              >
                {createSessionMutation.isPending ? (
                  <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {t("sessionsCreateAction")}
              </Button>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">{t("sessionsListTitle")}</p>
              {sessionsQuery.isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : sessionsQuery.data && sessionsQuery.data.length > 0 ? (
                sessionsQuery.data.map((entry) => (
                  <div key={entry.session.id} className="rounded-md border p-2 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">#{entry.session.id}</span>
                      <Badge
                        variant={entry.session.status === "completed" ? "secondary" : "outline"}
                      >
                        {tc(entry.session.status)}
                      </Badge>
                    </div>
                    <p>
                      {t("sessionsDateLabel")}: {entry.session.scheduled_for ? new Date(entry.session.scheduled_for).toLocaleString() : "-"}
                    </p>
                    <p>
                      {t("staff")}: {entry.commission.staff_display_name}
                    </p>
                    <p>
                      {t("sessionsAmountLabel")}: {formatCurrency(entry.session.session_amount)}
                    </p>
                    {entry.session.notes ? <p>{tc("notes")}: {entry.session.notes}</p> : null}
                    {entry.session.status === "scheduled" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => markSessionCompleted(entry.session.id)}
                        disabled={updateSessionStatusMutation.isPending}
                      >
                        {updateSessionStatusMutation.isPending ? (
                          <Loader2Icon className="mr-2 h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        {t("sessionsMarkCompleted")}
                      </Button>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">{t("sessionsEmpty")}</p>
              )}
            </div>

            <div className="rounded-md border p-3 space-y-2">
              <p className="text-sm font-medium">{t("agreementMediaTitle")}</p>
              <div className="grid gap-1">
                <Label>{t("agreementMediaSessionLabel")}</Label>
                <Select
                  value={mediaForm.sessionId || "all"}
                  onValueChange={(value) =>
                    setMediaForm((prev) => ({
                      ...prev,
                      sessionId: value === "all" ? "" : value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("agreementMediaSessionPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("agreementMediaSessionAll")}</SelectItem>
                    {(sessionsQuery.data ?? []).map((entry) => (
                      <SelectItem key={entry.session.id} value={String(entry.session.id)}>
                        #{entry.session.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label>{t("agreementMediaKindLabel")}</Label>
                <Select
                  value={mediaForm.mediaKind}
                  onValueChange={(value) =>
                    setMediaForm((prev) => ({
                      ...prev,
                      mediaKind: value as AgreementMediaKind,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="before">{t("agreementMediaKinds.before")}</SelectItem>
                    <SelectItem value="after">{t("agreementMediaKinds.after")}</SelectItem>
                    <SelectItem value="reference">{t("agreementMediaKinds.reference")}</SelectItem>
                    <SelectItem value="consent">{t("agreementMediaKinds.consent")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label>{t("agreementMediaUrlLabel")}</Label>
                <Input
                  value={mediaForm.mediaUrl}
                  onChange={(e) =>
                    setMediaForm((prev) => ({ ...prev, mediaUrl: e.target.value }))
                  }
                  placeholder={t("agreementMediaUrlPlaceholder")}
                />
              </div>
              <div className="grid gap-1">
                <Label>{t("agreementMediaCaptionLabel")}</Label>
                <Input
                  value={mediaForm.caption}
                  onChange={(e) =>
                    setMediaForm((prev) => ({ ...prev, caption: e.target.value }))
                  }
                  placeholder={t("agreementMediaCaptionPlaceholder")}
                />
              </div>
              <Button
                type="button"
                onClick={submitAgreementMedia}
                disabled={attachAgreementMediaMutation.isPending || selectedAgreementId == null}
                className="w-full"
              >
                {attachAgreementMediaMutation.isPending ? (
                  <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {t("agreementMediaAttachAction")}
              </Button>
              <div className="space-y-1">
                <p className="text-xs font-medium">{t("agreementMediaListTitle")}</p>
                {mediaQuery.isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : mediaQuery.data && mediaQuery.data.length > 0 ? (
                  mediaQuery.data.slice(0, 6).map((media) => (
                    <div key={media.id} className="rounded-md border p-2 text-xs space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{t(`agreementMediaKinds.${media.media_kind}`)}</span>
                        {media.service_agreement_session_id ? (
                          <Badge variant="outline">#{media.service_agreement_session_id}</Badge>
                        ) : null}
                      </div>
                      <a
                        href={media.media_url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline break-all"
                      >
                        {media.media_url}
                      </a>
                      {media.caption ? <p>{media.caption}</p> : null}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">{t("agreementMediaEmpty")}</p>
                )}
              </div>
            </div>

            <div className="rounded-md border p-3 space-y-2">
              <p className="text-sm font-medium">{t("consentTitle")}</p>
              <p className="text-xs text-muted-foreground">
                {selectedAgreementCustomer
                  ? t("consentCustomerLabel", { customer: selectedAgreementCustomer.name })
                  : t("consentNoCustomer")}
              </p>
              <p className="text-xs">
                {t("consentCurrentStatus")}: {customerConsentQuery.data?.status ? t(`consentStatuses.${customerConsentQuery.data.status}`) : t("consentStatuses.none")}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => updateWhatsAppConsent("granted")}
                  disabled={
                    upsertConsentMutation.isPending ||
                    selectedAgreement?.customer_id == null
                  }
                >
                  {t("consentGrantAction")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => updateWhatsAppConsent("revoked")}
                  disabled={
                    upsertConsentMutation.isPending ||
                    selectedAgreement?.customer_id == null
                  }
                >
                  {t("consentRevokeAction")}
                </Button>
              </div>
            </div>

            {outboxEventsQuery.data && outboxEventsQuery.data.length > 0 ? (
              <p className="text-xs text-muted-foreground">{t("followupHint")}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("payment")}</CardTitle>
            <p className="text-xs text-muted-foreground !mt-2">
              {t("paymentNote")}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {paymentLines.map((line, index) => (
              <div key={index} className="flex items-center gap-2">
                <div className="flex-1">
                  <Combobox
                    items={paymentMethods}
                    placeholder={t("paymentMethod")}
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
              <PlusIcon className="h-3 w-3 mr-1" /> {t("addPaymentMethod")}
            </Button>
            <div className="border-t pt-3 flex items-center justify-between">
              <span className="text-sm">{t("cartTotal")}</span>
              <strong>{formatCurrency(total)}</strong>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t("paymentsTotal")}</span>
              <strong className={paymentsMatch ? "" : "text-destructive"}>
                {formatCurrency(paymentsTotal)}
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
              {t("confirmSale")}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={quickServiceOpen}
        onOpenChange={(open) => {
          setQuickServiceOpen(open);
          if (!open) {
            setQuickServiceErrors({});
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("quickServiceTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1">
              <Label>{t("quickServiceCustomer")}</Label>
              <p className="text-sm text-muted-foreground">
                {selectedCustomer ? selectedCustomer.name : t("walkIn")}
              </p>
            </div>
            <div className="grid gap-1">
              <Label>{t("staff")}</Label>
              <Select
                value={quickServiceForm.artistId}
                onValueChange={(v) =>
                  setQuickServiceForm((prev) => ({ ...prev, artistId: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("pickStaffMember")} />
                </SelectTrigger>
                <SelectContent>
                  {(staffQuery.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {quickServiceErrors.artistId ? (
                <p className="text-xs text-destructive">{quickServiceErrors.artistId}</p>
              ) : null}
            </div>
            <div className="grid gap-1">
              <Label>{t("serviceKindLabel")}</Label>
              <Select
                value={quickServiceForm.serviceKind}
                onValueChange={(v) =>
                  setQuickServiceForm((prev) => ({
                    ...prev,
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
                      {tServiceKind(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label>{t("quickServiceName")}</Label>
              <Input
                value={quickServiceForm.serviceName}
                onChange={(e) =>
                  setQuickServiceForm((prev) => ({
                    ...prev,
                    serviceName: e.target.value,
                  }))
                }
                placeholder={t("quickServiceNamePlaceholder")}
              />
              {quickServiceErrors.serviceName ? (
                <p className="text-xs text-destructive">{quickServiceErrors.serviceName}</p>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <Label>{t("agreedTotal")}</Label>
                <Input
                  type="number"
                  min={1}
                  value={quickServiceForm.totalAgreedAmount}
                  onChange={(e) =>
                    setQuickServiceForm((prev) => ({
                      ...prev,
                      totalAgreedAmount: e.target.value,
                    }))
                  }
                  placeholder="0"
                />
                {quickServiceErrors.totalAgreedAmount ? (
                  <p className="text-xs text-destructive">
                    {quickServiceErrors.totalAgreedAmount}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1">
                <Label>{t("quickServiceInitialPayment")}</Label>
                <Input
                  type="number"
                  min={0}
                  value={quickServiceForm.initialPayment}
                  onChange={(e) =>
                    setQuickServiceForm((prev) => ({
                      ...prev,
                      initialPayment: e.target.value,
                    }))
                  }
                  placeholder="0"
                />
                {quickServiceErrors.initialPayment ? (
                  <p className="text-xs text-destructive">{quickServiceErrors.initialPayment}</p>
                ) : null}
              </div>
            </div>
            <div className="grid gap-1">
              <Label>{t("paymentMethod")}</Label>
              <Combobox
                items={paymentMethods}
                placeholder={t("paymentMethod")}
                onSelect={(id) =>
                  setQuickServiceForm((prev) => ({ ...prev, paymentMethodId: id }))
                }
              />
              <p className="text-xs text-muted-foreground">
                {t("quickServicePaymentHint")}
              </p>
              {quickServiceErrors.paymentMethodId ? (
                <p className="text-xs text-destructive">
                  {quickServiceErrors.paymentMethodId}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1">
              <Label>{tc("notes")}</Label>
              <Input
                value={quickServiceForm.notes}
                onChange={(e) =>
                  setQuickServiceForm((prev) => ({ ...prev, notes: e.target.value }))
                }
                placeholder={t("quickServiceNotesPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setQuickServiceOpen(false)}
              disabled={quickServiceSubmitting}
            >
              {tc("cancel")}
            </Button>
            <Button
              onClick={confirmQuickService}
              disabled={quickServiceSubmitting}
            >
              {quickServiceSubmitting ? (
                <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t("quickServiceConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={serviceDialogProductId != null}
        onOpenChange={(open) => !open && setServiceDialogProductId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("serviceDialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>{t("staff")}</Label>
              <Select
                value={serviceForm.staffMemberId}
                onValueChange={(v) =>
                  setServiceForm((s) => ({ ...s, staffMemberId: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("pickStaffMember")} />
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
              <Label>{t("serviceKindLabel")}</Label>
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
                      {tServiceKind(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("bodyLocationLabel")}</Label>
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
              {t("completeLater")}
            </Button>
            <Button onClick={saveServiceIntent}>{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
