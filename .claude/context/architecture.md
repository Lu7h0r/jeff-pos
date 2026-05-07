# Arquitectura — FinOpenPOS Jeff

## Estructura de Directorios

```
src/
  app/
    admin/              # UI admin (Next.js App Router)
      cashier/          # POS / caja
      pos/              # point of sale
      products/         # gestión de productos
      inventory/        # inventario por sede
      orders/           # órdenes / ventas
      expenses/         # gastos operativos
      purchases/        # órdenes de compra
      staff/            # staff y artistas
      workstations/     # estaciones
      station-rentals/  # alquiler a guest artists
      team/             # miembros del equipo
      customers/        # clientes
      payment-methods/  # métodos de pago
    login/              # auth pages
    signup/
  lib/
    db/
      schema.ts         # FUENTE DE VERDAD de todas las tablas
      seed.jeff.ts      # seed inicial (Amparo + Britalia + demo user)
    trpc/
      routers/          # un archivo por dominio
        __tests__/      # tests Bun; helpers.ts = TABLES registry
      active-context.ts # resolución business+location
      scope-guards.ts   # guards multi-tenant
      role-guards.ts    # guards de rol
      commission-split.ts
    auth.ts             # Better Auth config (cookie prefix: sanctum)
    auth-guard.ts       # middleware de auth para rutas admin
  components/
    admin-layout.tsx    # layout principal admin
    location-selector.tsx
    ui/                 # shadcn/ui components
  proxy.ts              # proxy con detección de cookie sanctum
scripts/
  ensure-db.ts
  migrate.ts
  generate-er.ts
  import-treinta-inventory.ts
  bootstrap-prod.ts
docs/jeff/
  PLAN.md     # plan vivo por batches
  DEUDA.md    # bugs rastreados (DA-1..DA-N)
  DEPLOY.md   # runbook de producción
```

## Patrón: tRPC + Drizzle

Routers tRPC delgados → lógica en el mismo archivo para routers simples, extraer a helpers para lógica compleja.

```typescript
// Patrón de router estándar
export const myRouter = router({
  list: protectedProcedure
    .input(z.object({ locationId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const context = await resolveActiveContext(ctx.session.user.id, input.locationId);
      if (!context) throw new TRPCError({ code: 'FORBIDDEN' });
      // query scoped by context.businessId + context.effectiveLocationIds
    }),
});
```

## Tablas del Schema (principales)

| Tabla | Descripción |
|-------|-------------|
| `businesses` | Negocio raíz |
| `business_members` | Acceso BROAD (owner/manager/cashier/artist) |
| `locations` | Sedes (Amparo, Britalia) |
| `location_members` | Acceso GRANULAR por sede |
| `products` | Catálogo con costo/precio/fotos |
| `inventory_balances` | Stock actual por (product, location) |
| `inventory_movements` | Historial de movimientos de stock |
| `orders` | Órdenes/ventas |
| `order_items` | Líneas de venta |
| `order_payments` | Pagos (multi-payment) |
| `cash_sessions` | Turnos de caja por local |
| `cash_movements` | Movimientos dentro de un turno |
| `expense_categories` | Categorías de gasto |
| `expense_entries` | Gastos operativos |
| `suppliers` | Proveedores |
| `purchase_orders` + `purchase_items` | Órdenes de compra |
| `staff_members` | Staff / artistas |
| `workstations` | Estaciones por sede |
| `station_rentals` | Alquileres a guest artists |
| `service_sales` | Ventas de servicios (tatuajes, piercings) |
| `commission_estimates` | Estimaciones de comisión |
| `customers` | Clientes |
| `payment_methods` | Métodos de pago configurados |

## Tests

Un archivo por router en `src/lib/trpc/routers/__tests__/`. El helper `helpers.ts:TABLES` define el orden de limpieza para evitar FK violations. Bun test nativo — sin Jest.

## i18n

`messages/` con archivos por idioma. `next-intl` para traducciones. Solo español para el producto Jeff.
