"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { MapPinIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useTRPC } from "@/lib/trpc/client";

const COOKIE_KEY = "jeff_active_location_id";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function readCookie(): number | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/jeff_active_location_id=(\d+)/);
  return match ? Number(match[1]) : null;
}

function writeCookie(id: number): void {
  document.cookie = `${COOKIE_KEY}=${id}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function LocationSelector() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: locations, isLoading } = useQuery(
    trpc.locations.list.queryOptions(),
  );
  const [activeId, setActiveId] = useState<number | null>(null);

  useEffect(() => {
    if (!locations || locations.length === 0) return;

    const fromCookie = readCookie();
    const cookieMatchesAvailable = fromCookie !== null
      && locations.some((loc) => loc.id === fromCookie);

    if (cookieMatchesAvailable) {
      setActiveId(fromCookie);
    } else {
      const fallback = locations[0].id;
      setActiveId(fallback);
      writeCookie(fallback);
    }
  }, [locations]);

  if (isLoading || !locations || locations.length === 0) return null;

  const active = locations.find((loc) => loc.id === activeId) ?? locations[0];

  const handleChange = (id: number) => {
    setActiveId(id);
    writeCookie(id);
    // React Query has no observer on cookies, so changing the cookie alone
    // does not trigger refetches. Invalidate every active query so the next
    // refetch hits the server with the new cookie (read by createTRPCContext)
    // and brings back data scoped to the newly selected location. Also refresh
    // server components in case any admin layout reads the cookie on the server.
    queryClient.invalidateQueries();
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 shrink-0">
          <MapPinIcon className="h-4 w-4" />
          <span className="hidden sm:inline truncate max-w-[120px]">
            {active.name}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Local activo</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {locations.map((loc) => (
          <DropdownMenuItem
            key={loc.id}
            onClick={() => handleChange(loc.id)}
            className={loc.id === active.id ? "font-semibold" : ""}
          >
            {loc.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
