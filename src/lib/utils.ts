import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Colombian peso (COP) does not use minor units in everyday accounting.
// Even though the SQL columns are integer, the stored value is treated as
// whole pesos: 200000 → "$200.000". Never divide by 100 at the boundary.
const LOCALE = "es-CO";
const CURRENCY = "COP";

const CURRENCY_FORMATTER = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  maximumFractionDigits: 0,
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
});

const DATE_FORMATTER = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
});

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
});

export function formatCurrency(amount: number) {
  return CURRENCY_FORMATTER.format(amount);
}

export function formatDate(date: Date | string) {
  if (typeof date === "string") {
    date = new Date(date);
  }
  return DATE_TIME_FORMATTER.format(date);
}

export function formatDateOnly(date: Date | string) {
  if (typeof date === "string") {
    date = new Date(date);
  }
  return DATE_FORMATTER.format(date);
}

export function formatShortDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return SHORT_DATE_FORMATTER.format(d);
}
