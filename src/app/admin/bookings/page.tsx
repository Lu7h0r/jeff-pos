"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarPlusIcon,
  CalendarXIcon,
  CheckCircle2Icon,
  FileCheck2Icon,
  HistoryIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DataTable,
  TableActionButton,
  TableActions,
  type Column,
} from "@/components/ui/data-table";
import { useTRPC } from "@/lib/trpc/client";
import { useCrudMutation } from "@/hooks/use-crud-mutation";
import { formatDate } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc/router";

type Booking = RouterOutputs["bookings"]["list"][number];

function startOfDayISO(value: string): string {
  return `${value}T00:00:00.000Z`;
}

function endOfDayISO(value: string): string {
  return `${value}T23:59:59.999Z`;
}

function startOfWeekISO(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diffToMonday);
  return date.toISOString().slice(0, 10);
}

function addDaysISO(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function BookingsPage() {
  const t = useTranslations("bookings");
  const tCommon = useTranslations("common");
  const trpc = useTRPC();
  const locationsQuery = useQuery(trpc.locations.list.queryOptions());
  const locations = locationsQuery.data ?? [];
  const staffQuery = useQuery(trpc.staff.list.queryOptions());
  const staff = staffQuery.data ?? [];

  const today = new Date().toISOString().slice(0, 10);
  const [selectedDay, setSelectedDay] = useState(today);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"tattoo" | "piercing" | "other">("tattoo");
  const [startsAt, setStartsAt] = useState("10:00");
  const [endsAt, setEndsAt] = useState("11:00");
  const [locationId, setLocationId] = useState<number | null>(null);
  const [filterStaffId, setFilterStaffId] = useState<number | null>(null);
  const [createStaffId, setCreateStaffId] = useState<number | null>(null);
  const [selectedBookingId, setSelectedBookingId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"day" | "week">("day");

  const rangeStartDay = viewMode === "day" ? selectedDay : startOfWeekISO(selectedDay);
  const rangeEndDay = viewMode === "day" ? selectedDay : addDaysISO(rangeStartDay, 6);

  const startsAtDate = useMemo(
    () => new Date(`${selectedDay}T${startsAt}:00`),
    [selectedDay, startsAt],
  );
  const endsAtDate = useMemo(
    () => new Date(`${selectedDay}T${endsAt}:00`),
    [selectedDay, endsAt],
  );

  const listQuery = useQuery(
    trpc.bookings.list.queryOptions({
      startsAt: new Date(startOfDayISO(rangeStartDay)),
      endsAt: new Date(endOfDayISO(rangeEndDay)),
      locationId: locationId ?? undefined,
      staffId: filterStaffId ?? undefined,
    }),
  );

  const summaryQuery = useQuery(
    trpc.bookings.summary.queryOptions({
      startsAt: new Date(startOfDayISO(rangeStartDay)),
      endsAt: new Date(endOfDayISO(rangeEndDay)),
      locationId: locationId ?? undefined,
      staffId: filterStaffId ?? undefined,
    }),
  );

  const invalidateKeys = trpc.bookings.list.queryOptions({
    startsAt: new Date(startOfDayISO(rangeStartDay)),
    endsAt: new Date(endOfDayISO(rangeEndDay)),
    locationId: locationId ?? undefined,
    staffId: filterStaffId ?? undefined,
  }).queryKey;

  const createMutation = useCrudMutation({
    mutationOptions: trpc.bookings.create.mutationOptions(),
    invalidateKeys,
    successMessage: t("created"),
    errorMessage: t("createFailed"),
    onSuccess: () => {
      setTitle("");
    },
  });

  const statusMutation = useCrudMutation({
    mutationOptions: trpc.bookings.updateStatus.mutationOptions(),
    invalidateKeys,
    successMessage: t("updated"),
    errorMessage: t("updateFailed"),
  });

  const cancelMutation = useCrudMutation({
    mutationOptions: trpc.bookings.cancel.mutationOptions(),
    invalidateKeys,
    successMessage: t("cancelled"),
    errorMessage: t("cancelFailed"),
  });

  const rescheduleMutation = useCrudMutation({
    mutationOptions: trpc.bookings.reschedule.mutationOptions(),
    invalidateKeys,
    successMessage: t("rescheduled"),
    errorMessage: t("rescheduleFailed"),
  });

  const convertMutation = useCrudMutation({
    mutationOptions: trpc.bookings.convertToServiceAgreement.mutationOptions(),
    invalidateKeys,
    successMessage: t("converted"),
    errorMessage: t("convertFailed"),
  });

  const bookings = listQuery.data ?? [];
  const historyQuery = useQuery({
    ...trpc.bookings.listEvents.queryOptions({ bookingId: selectedBookingId ?? 1 }),
    enabled: selectedBookingId != null,
  });
  const bookingHistory = historyQuery.data ?? [];

  const statusLabel: Record<Booking["status"], string> = {
    pending: t("statusPending"),
    confirmed: t("statusConfirmed"),
    checked_in: t("statusCheckedIn"),
    completed: t("statusCompleted"),
    cancelled: t("statusCancelled"),
    no_show: t("statusNoShow"),
  };
  const confirmationLabel: Record<
    Booking["confirmation_status"],
    string
  > = {
    pending: t("confirmationPending"),
    confirmed: t("confirmationConfirmed"),
    unconfirmed: t("confirmationUnconfirmed"),
  };

  const kindLabel: Record<Booking["service_kind"], string> = {
    tattoo: t("kindTattoo"),
    piercing: t("kindPiercing"),
    other: t("kindOther"),
  };

  const eventLabel: Record<string, string> = {
    create: t("eventCreate"),
    confirm: t("eventConfirm"),
    reschedule: t("eventReschedule"),
    cancel: t("eventCancel"),
    check_in: t("eventCheckIn"),
    no_show: t("eventNoShow"),
    completed: t("eventCompleted"),
    convert_to_service: t("eventConvert"),
  };

  const staffNameById = useMemo(
    () => new Map(staff.map((member) => [member.id, member.display_name])),
    [staff],
  );

  const columns: Column<Booking>[] = [
    { key: "title", header: t("colTitle"), className: "font-medium" },
    {
      key: "service_kind",
      header: t("colKind"),
      render: (row) => kindLabel[row.service_kind],
    },
    {
      key: "starts_at",
      header: t("colSchedule"),
      render: (row) => `${formatDate(row.starts_at)} - ${formatDate(row.ends_at)}`,
    },
    {
      key: "status",
      header: tCommon("status"),
      render: (row) => statusLabel[row.status],
    },
    {
      key: "confirmation_status",
      header: t("colConfirmation"),
      render: (row) => confirmationLabel[row.confirmation_status],
    },
    {
      key: "staff_id",
      header: t("colStaff"),
      render: (row) =>
        row.staff_id != null ? (staffNameById.get(row.staff_id) ?? `#${row.staff_id}`) : "-",
    },
    {
      key: "actions",
      header: tCommon("actions"),
      render: (row) => (
        <TableActions>
          <TableActionButton
            onClick={() => setSelectedBookingId(row.id)}
            icon={<HistoryIcon className="size-4" />}
            label={t("actionHistory")}
          />
          <TableActionButton
            onClick={() =>
              statusMutation.mutate({ bookingId: row.id, status: "confirmed" })
            }
            icon={<CheckCircle2Icon className="size-4" />}
            label={t("actionConfirm")}
          />
          <TableActionButton
            onClick={() =>
              statusMutation.mutate({ bookingId: row.id, status: "completed" })
            }
            icon={<CalendarCheckIcon className="size-4" />}
            label={t("actionComplete")}
          />
          <TableActionButton
            onClick={() => {
              const nextStart = typeof window !== "undefined" ? window.prompt(t("promptStart"), startsAt) : null;
              const nextEnd = typeof window !== "undefined" ? window.prompt(t("promptEnd"), endsAt) : null;
              if (!nextStart || !nextEnd) return;
              rescheduleMutation.mutate({
                bookingId: row.id,
                startsAt: new Date(`${selectedDay}T${nextStart}:00`),
                endsAt: new Date(`${selectedDay}T${nextEnd}:00`),
              });
            }}
            icon={<CalendarClockIcon className="size-4" />}
            label={t("actionReschedule")}
          />
          <TableActionButton
            variant="danger"
            onClick={() => cancelMutation.mutate({ bookingId: row.id })}
            icon={<CalendarXIcon className="size-4" />}
            label={tCommon("cancel")}
          />
          <TableActionButton
            onClick={() => convertMutation.mutate({ bookingId: row.id })}
            icon={<FileCheck2Icon className="size-4" />}
            label={t("actionConvert")}
          />
        </TableActions>
      ),
    },
  ];

  return (
    <Card className="flex flex-col gap-4 p-3 sm:gap-6 sm:p-6">
      <CardHeader className="p-0 space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{t("kpiTotal")}</p>
              <p className="text-2xl font-semibold">
                {summaryQuery.data?.totalBookings ?? 0}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{t("kpiConfirmedRate")}</p>
              <p className="text-2xl font-semibold">
                {Math.round((summaryQuery.data?.confirmedRate ?? 0) * 100)}%
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{t("kpiNoShowRate")}</p>
              <p className="text-2xl font-semibold">
                {Math.round((summaryQuery.data?.noShowRate ?? 0) * 100)}%
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{t("kpiConversionRate")}</p>
              <p className="text-2xl font-semibold">
                {Math.round(
                  (summaryQuery.data?.conversionToServiceAgreementRate ?? 0) *
                    100,
                )}
                %
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label htmlFor="booking-day">{t("day")}</Label>
            <Input
              id="booking-day"
              type="date"
              value={selectedDay}
              onChange={(event) => setSelectedDay(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="booking-view">{t("viewLabel")}</Label>
            <select
              id="booking-view"
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={viewMode}
              onChange={(event) => setViewMode(event.target.value as "day" | "week")}
            >
              <option value="day">{t("viewDay")}</option>
              <option value="week">{t("viewWeek")}</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="booking-staff-filter">{t("staffFilter")}</Label>
            <select
              id="booking-staff-filter"
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={filterStaffId ?? ""}
              onChange={(event) =>
                setFilterStaffId(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">{t("allStaff")}</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="booking-location">{tCommon("location")}</Label>
            <select
              id="booking-location"
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={locationId ?? ""}
              onChange={(event) =>
                setLocationId(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">{t("allLocations")}</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="booking-title">{t("quickTitle")}</Label>
            <Input
              id="booking-title"
              placeholder={t("quickTitlePlaceholder")}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="booking-kind">{t("quickKind")}</Label>
            <select
              id="booking-kind"
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={kind}
              onChange={(event) => setKind(event.target.value as "tattoo" | "piercing" | "other")}
            >
              <option value="tattoo">{t("kindTattoo")}</option>
              <option value="piercing">{t("kindPiercing")}</option>
              <option value="other">{t("kindOther")}</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="booking-staff-create">{t("staffRequired")}</Label>
            <select
              id="booking-staff-create"
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={createStaffId ?? ""}
              onChange={(event) =>
                setCreateStaffId(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">{t("selectStaff")}</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="booking-start">{t("quickStart")}</Label>
            <Input id="booking-start" type="time" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="booking-end">{t("quickEnd")}</Label>
            <Input id="booking-end" type="time" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
          </div>
        </div>

        <div>
          <Button
            onClick={() =>
              createMutation.mutate({
                locationId: locationId ?? locations[0]?.id ?? 0,
                staffId: createStaffId ?? 0,
                serviceKind: kind,
                title,
                startsAt: startsAtDate,
                endsAt: endsAtDate,
              })
            }
            disabled={
              title.trim().length === 0 ||
              createMutation.isPending ||
              createStaffId == null ||
              (locationId == null && locations.length === 0)
            }
          >
            <CalendarPlusIcon className="w-4 h-4 mr-2" />
            {t("quickCreate")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <DataTable
          data={bookings}
          columns={columns}
          emptyMessage={t("empty")}
        />
        <div className="mt-4 rounded-lg border p-3">
          {viewMode === "week" ? (
            <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
              {Array.from({ length: 7 }, (_, index) => {
                const day = addDaysISO(rangeStartDay, index);
                const dayBookings = bookings
                  .filter((booking) => booking.starts_at.toISOString().slice(0, 10) === day)
                  .sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime());

                return (
                  <div key={day} className="rounded-md border p-2">
                    <p className="mb-1 text-xs font-medium">{day}</p>
                    {dayBookings.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("weekEmptyDay")}</p>
                    ) : (
                      <div className="space-y-1">
                        {dayBookings.map((booking) => (
                          <button
                            key={booking.id}
                            type="button"
                            className="w-full rounded border px-2 py-1 text-left text-xs hover:bg-accent"
                            onClick={() => setSelectedBookingId(booking.id)}
                          >
                            {booking.starts_at.toISOString().slice(11, 16)} · {booking.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">{t("historyTitle")}</p>
            {selectedBookingId != null ? (
              <p className="text-xs text-muted-foreground">
                #{selectedBookingId}
              </p>
            ) : null}
          </div>
          {selectedBookingId == null ? (
            <p className="text-sm text-muted-foreground">{t("historySelectHint")}</p>
          ) : historyQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("historyLoading")}</p>
          ) : bookingHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p>
          ) : (
            <div className="space-y-1">
              {bookingHistory.slice(0, 6).map((event) => (
                <p key={event.id} className="text-sm">
                  {eventLabel[event.event_type] ?? event.event_type} - {formatDate(event.created_at ?? new Date())}
                </p>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
