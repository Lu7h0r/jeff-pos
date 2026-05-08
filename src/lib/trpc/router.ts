import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { router } from "./init";
import { productsRouter } from "./routers/products";
import { customersRouter } from "./routers/customers";
import { ordersRouter } from "./routers/orders";
import { paymentMethodsRouter } from "./routers/payment-methods";
import { dashboardRouter } from "./routers/dashboard";
import { businessesRouter } from "./routers/businesses";
import { locationsRouter } from "./routers/locations";
import { cashSessionsRouter } from "./routers/cash-sessions";
import { inventoryRouter } from "./routers/inventory";
import { expensesRouter } from "./routers/expenses";
import { suppliersRouter } from "./routers/suppliers";
import { purchasesRouter } from "./routers/purchases";
import { staffRouter } from "./routers/staff";
import { workstationsRouter } from "./routers/workstations";
import { stationRentalsRouter } from "./routers/station-rentals";
import { servicesRouter } from "./routers/services";
import { locationMembersRouter } from "./routers/location-members";
import { teamRouter } from "./routers/team";
import { serviceAgreementsRouter } from "./routers/service-agreements";
import { bookingsRouter } from "./routers/bookings";

export const appRouter = router({
  products: productsRouter,
  customers: customersRouter,
  orders: ordersRouter,
  paymentMethods: paymentMethodsRouter,
  dashboard: dashboardRouter,
  businesses: businessesRouter,
  locations: locationsRouter,
  cashSessions: cashSessionsRouter,
  inventory: inventoryRouter,
  expenses: expensesRouter,
  suppliers: suppliersRouter,
  purchases: purchasesRouter,
  staff: staffRouter,
  workstations: workstationsRouter,
  stationRentals: stationRentalsRouter,
  services: servicesRouter,
  locationMembers: locationMembersRouter,
  team: teamRouter,
  serviceAgreements: serviceAgreementsRouter,
  bookings: bookingsRouter,
});

export type AppRouter = typeof appRouter;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
