# Backend Patterns — FinOpenPOS Jeff

## tRPC + Drizzle ORM

### Scope multi-tenant (CRÍTICO)

Siempre resolver contexto antes de cualquier operación:

```typescript
const context = await resolveActiveContext(ctx.session.user.id, input.locationId);
if (!context) throw new TRPCError({ code: 'FORBIDDEN' });

// Queries SIEMPRE con business_id
const items = await db.select()
  .from(myTable)
  .where(
    and(
      eq(myTable.business_id, context.businessId),
      inArray(myTable.location_id, context.effectiveLocationIds)
    )
  );
```

### Guards disponibles

```typescript
import { requireRole } from '@/lib/trpc/role-guards';
import { requireLocationScope } from '@/lib/trpc/scope-guards';

// Verificar rol mínimo
requireRole(context.role, 'manager'); // throws FORBIDDEN si no alcanza

// Verificar que el locationId pedido está en el scope del usuario
requireLocationScope(context, input.locationId); // throws FORBIDDEN si no
```

### Transacción atómica (patrón orders)

```typescript
await db.transaction(async (tx) => {
  // 1. Computar total desde DB (nunca confiar en input.total)
  // 2. Validar pagos === total
  // 3. Descontar inventario con guarda atómica
  const [updated] = await tx
    .update(inventoryBalances)
    .set({ quantity_on_hand: sql`quantity_on_hand - ${qty}` })
    .where(
      and(
        eq(inventoryBalances.id, balanceId),
        gte(inventoryBalances.quantity_on_hand, qty)
      )
    )
    .returning();
  if (!updated) throw new TRPCError({ code: 'CONFLICT', message: 'Insufficient stock' });
  // 4. Crear order + items + payments + movements
});
```

### Drizzle queries

```typescript
// SELECT con join
const result = await db
  .select({ id: orders.id, total: orders.total_amount })
  .from(orders)
  .leftJoin(orderItems, eq(orderItems.order_id, orders.id))
  .where(eq(orders.business_id, context.businessId))
  .orderBy(desc(orders.created_at));

// INSERT con returning
const [newRow] = await db.insert(myTable).values({ ... }).returning();
```

### Error codes tRPC

| Código | Cuándo |
|--------|--------|
| `FORBIDDEN` | Sin permisos (rol o scope) |
| `UNAUTHORIZED` | Sin sesión |
| `NOT_FOUND` | Recurso no existe |
| `CONFLICT` | Violación de unicidad o stock insuficiente |
| `BAD_REQUEST` | Validación de negocio fallida |

## Better Auth

Cookie prefix `sanctum`. El guard en `src/lib/auth-guard.ts` detecta la cookie por nombre (`sanctum.session_token` o variante). No confiar en helpers default de Better Auth para detectar sesión activa — usar el getter explícito.

```typescript
// auth.ts tiene el prefix
export const auth = betterAuth({
  advanced: { cookiePrefix: 'sanctum' },
  // ...
});
```

## PGlite (dev) vs Postgres (prod)

- PGlite: file-based, un solo escritor a la vez. Parar `bun run dev` antes de `db:push`, `db:seed:jeff` o `db:migrate`.
- Postgres prod: `DATABASE_URL` en `.env`. Mismo schema Drizzle.
- `drizzle.config.ts` detecta el entorno automáticamente.

## Schema Changes

1. Editar `src/lib/db/schema.ts`
2. `bun run db:generate` → genera migración SQL en `drizzle/`
3. `bun run db:migrate` → aplica
4. Actualizar `__tests__/helpers.ts:TABLES` si es tabla nueva

## Validación de Input (Zod)

Usar Zod en el `.input()` del procedure. Validaciones de negocio (stock, totales, permisos) van dentro del handler, no en Zod.
