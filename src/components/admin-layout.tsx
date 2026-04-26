"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { usePathname } from "next/navigation";
import Image from "next/image";
import {
  Package2Icon,
  LayoutDashboardIcon,
  DollarSignIcon,
  PackageIcon,
  ShoppingCartIcon,
  UsersIcon,
  ShoppingBagIcon,
  CreditCardIcon,
  WarehouseIcon,
  ReceiptIcon,
  TruckIcon,
  ShoppingBasketIcon,
  UserIcon,
  MonitorIcon,
  ClockIcon,
  MenuIcon,
  XIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";

import { logout } from "@/app/login/actions";
import { LocationSelector } from "@/components/location-selector";

interface NavItem {
  href: string;
  labelKey: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { href: "/admin", labelKey: "dashboard", icon: LayoutDashboardIcon },
  { href: "/admin/cashier", labelKey: "cashier", icon: DollarSignIcon },
  { href: "/admin/products", labelKey: "products", icon: PackageIcon },
  { href: "/admin/inventory", labelKey: "inventory", icon: WarehouseIcon },
  { href: "/admin/customers", labelKey: "customers", icon: UsersIcon },
  { href: "/admin/orders", labelKey: "orders", icon: ShoppingBagIcon },
  { href: "/admin/payment-methods", labelKey: "paymentMethods", icon: CreditCardIcon },
  { href: "/admin/expenses", labelKey: "expenses", icon: ReceiptIcon },
  { href: "/admin/suppliers", labelKey: "suppliers", icon: TruckIcon },
  { href: "/admin/purchases", labelKey: "purchases", icon: ShoppingBasketIcon },
  { href: "/admin/staff", labelKey: "staff", icon: UserIcon },
  { href: "/admin/workstations", labelKey: "workstations", icon: MonitorIcon },
  { href: "/admin/station-rentals", labelKey: "stationRentals", icon: ClockIcon },
  { href: "/admin/pos", labelKey: "pos", icon: ShoppingCartIcon },
  { href: "/admin/team", labelKey: "team", icon: UsersRoundIcon },
];

// Visual gate by role. The backend `requireRole` middleware is the security
// boundary; this map only hides nav items the role cannot use anyway. Any
// route NOT listed in a role's set is hidden. Owners and managers see
// everything, with Team management restricted to owner.
const NAV_BY_ROLE: Record<string, ReadonlySet<string>> = {
  owner: new Set(navItems.map((item) => item.href)),
  manager: new Set(
    navItems
      .filter((item) => item.href !== "/admin/team")
      .map((item) => item.href),
  ),
  cashier: new Set([
    "/admin",
    "/admin/pos",
    "/admin/cashier",
    "/admin/customers",
    "/admin/inventory",
  ]),
  artist: new Set(["/admin", "/admin/pos", "/admin/customers"]),
  viewer: new Set(["/admin"]),
};

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const tNav = useTranslations("nav");
  const tLayout = useTranslations("layout");
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const trpc = useTRPC();
  const businessQuery = useQuery(trpc.businesses.getCurrent.queryOptions());
  const role = businessQuery.data?.role ?? null;

  const visibleNavItems = useMemo(() => {
    if (!role) return navItems;
    const allowed = NAV_BY_ROLE[role];
    if (!allowed) return navItems;
    return navItems.filter((item) => allowed.has(item.href));
  }, [role]);

  const pageTitle =
    navItems.find((item) => item.href === pathname)?.labelKey ?? null;

  return (
    <div className="flex min-h-screen w-full flex-col bg-muted/40">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background px-3 sm:px-4 sm:gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden shrink-0"
          onClick={() => setMobileMenuOpen(true)}
        >
          <MenuIcon className="h-5 w-5" />
          <span className="sr-only">{tLayout("openMenu")}</span>
        </Button>
        <Link
          href="/admin"
          className="hidden sm:flex items-center gap-2 text-lg font-semibold"
        >
          <Package2Icon className="h-6 w-6" />
          <span className="sr-only">{tLayout("adminPanel")}</span>
        </Link>
        <h1 className="text-lg sm:text-xl font-bold truncate">
          {pageTitle ? tNav(pageTitle) : ""}
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <LocationSelector />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="overflow-hidden rounded-full shrink-0"
              >
                <Image
                  src="/placeholder-user.jpg"
                  width={36}
                  height={36}
                  alt={tLayout("avatar")}
                  className="overflow-hidden rounded-full"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{tLayout("myAccount")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>{tLayout("settings")}</DropdownMenuItem>
              <DropdownMenuItem>{tLayout("support")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => logout()}>
                {tLayout("logout")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Mobile drawer overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 sm:hidden">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          <nav className="fixed inset-y-0 left-0 w-64 bg-background border-r p-4 flex flex-col gap-2 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <Link
                href="/admin"
                className="flex items-center gap-2 text-lg font-semibold"
                onClick={() => setMobileMenuOpen(false)}
              >
                <Package2Icon className="h-6 w-6" />
                <span>FinOpenPOS</span>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileMenuOpen(false)}
              >
                <XIcon className="h-5 w-5" />
              </Button>
            </div>
            {visibleNavItems.map(({ href, labelKey, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  pathname === href
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                {tNav(labelKey)}
              </Link>
            ))}
          </nav>
        </div>
      )}

      <div className="flex flex-col sm:gap-4 sm:py-4 sm:pl-14">
        <aside className="fixed mt-[56px] inset-y-0 left-0 z-10 hidden w-14 flex-col border-r bg-background sm:flex">
          <nav className="flex flex-col items-center gap-4 px-2 sm:py-5">
            <TooltipProvider>
              {visibleNavItems.map(({ href, labelKey, icon: Icon }) => (
                <Tooltip key={href}>
                  <TooltipTrigger asChild>
                    <Link
                      href={href}
                      className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                        pathname === href
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground"
                      } transition-colors hover:text-foreground md:h-8 md:w-8`}
                    >
                      <Icon className="h-5 w-5" />
                      <span className="sr-only">{tNav(labelKey)}</span>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right">{tNav(labelKey)}</TooltipContent>
                </Tooltip>
              ))}
            </TooltipProvider>
          </nav>
        </aside>
        <main className="flex-1 p-3 sm:px-6 sm:py-0 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
