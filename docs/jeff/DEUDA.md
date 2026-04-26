# Deuda Activa — FinOpenPOS Jeff

Bugs presentes en el codigo upstream de FinOpenPOS al momento de iniciar el fork (commit `c072829`, v0.5.1). No bloquean Batch 1 pero deben rastrearse hasta su resolucion.

Cada item indica:

- ID estable (DA-N) para referenciar desde commits y tests.
- Ubicacion exacta archivo:linea.
- Impacto operativo.
- Batch donde se resuelve.
- Estado actual.

## DA-1 — `orders.create` acepta `total` del cliente sin recalcular

**Ubicacion:** `src/lib/trpc/routers/orders.ts:54` — `total_amount: input.total`.

**Impacto:** un cliente puede mandar `total: 1` para cualquier orden. La validacion de cantidad existe solo en `src/app/admin/pos/page.tsx:64-70` (cliente). El servidor no recalcula.

**Resolucion:** Batch 4. `orders.create` recalcula total leyendo precios desde `products` por `id` dentro de la misma transaccion. El `input.total` se acepta solo como hint para validacion contra el calculo servidor (mismatch = error).

**Estado:** abierta. No usar en produccion real hasta cierre de Batch 4.

## DA-2 — `orders.create` nunca descuenta stock

**Ubicacion:** `src/lib/trpc/routers/orders.ts` — todo el flujo de `create`. No existe ningun `update` sobre `products.in_stock` ni sobre tabla de inventario.

**Impacto:** `products.in_stock` nunca baja tras una venta. La UI valida stock client-side pero el servidor no hace nada. **El inventario esta corrupto desde el primer dia de uso real.** Hoy `in_stock` es decorativo.

**Resolucion:** Batch 3 introduce `inventory_balances` + `inventory_movements`. Batch 4 hace que `orders.create` cree movimientos `sale` y actualice `inventory_balances` dentro de la misma transaccion DB que crea la orden, validando `quantity_on_hand >= requested` con condicion atomica para evitar stock negativo por carrera.

**Estado:** abierta. No tomar decisiones operativas basadas en `in_stock` actual.

## DA-3 — `orders.delete` tiene FK bug con transactions

**Ubicacion:** `src/lib/trpc/routers/orders.ts:123-133`. Borra `orderItems` y luego `orders`. Pero `transactions.order_id` tiene FK a `orders.id`. Si existe transaccion, el delete falla con error de FK.

**Test que documenta el bug:** `src/lib/trpc/routers/__tests__/orders.test.ts:200-215`.

**Impacto:** una orden con cobro registrado no se puede borrar via UI. Hoy es bug pasivo (la UI rara vez intenta borrar). Cuando la operacion real arranque, el patron de "borrar venta" debe estar resuelto.

**Resolucion:** Batch 4. **No** se implementa soft-delete ni se arregla el delete actual. En su lugar se introduce el patron `orders.void` (inspirado en NexoPOS):

- `orders.process_status` agrega valor `void`.
- `orders.voidance_reason` text nullable.
- `orders.voided_at` timestamp nullable.
- mutation tRPC `orders.void` marca la orden, crea `inventory_movements` reverso (devuelve stock al local), crea `cash_movements` reverso (revierte efecto en caja del turno).
- la fila nunca se borra. Se mantiene para auditoria contable.

La UI cambia "Borrar venta" → "Anular venta" con motivo obligatorio.

**Estado:** abierta. Se cierra con la implementacion de void en Batch 4.

## DA-4 — `customers` no tiene `business_id`

**Ubicacion:** `src/lib/db/schema.ts` — tabla `customers` aisla por `user_uid` (Better Auth user).

**Impacto:** cuando haya empleados (cashier, artist), cada uno ve solo los clientes que el mismo creo. La cliente que llega a Britalia atendida por un cashier no la ve el manager que entra desde Amparo. Modelo incompatible con el negocio Jeff.

**Resolucion:** Batch 1. Agregar columna `customers.business_id` nullable. Migracion en dos pasos:

1. Batch 1: agregar columna nullable, dejar `user_uid` intacto. Routers filtran por `business_id IS NOT NULL ? = :businessId : user_uid = :userId` (fallback temporal).
2. Batch 2 o 3: backfill de `business_id` desde memberships del `user_uid` correspondiente, hacer NOT NULL, eventualmente quitar dependencia de `user_uid` para customers.

**Estado:** mitigada a nivel query.

**Cerrado parcial:** commit `26a3fe0` (Batch 1) agrega columna nullable. Commits `7a215ae` + `a392abf` (Batch 1.5) introducen `resolveActiveContext` y migran `customers.list`/`customers.create` a usar `ctx.activeBusinessId` con fallback `user_uid`. Pendiente final: backfill de datos existentes y NOT NULL en Batch 3 cuando inventory exista y los datos legacy se puedan migrar coherentemente.

## DA-5 — `paymentMethods` no tiene scope de negocio

**Ubicacion:** `src/lib/db/schema.ts` — tabla `paymentMethods` es global, sin `user_uid` ni `business_id`.

**Impacto:** todos los metodos de pago aparecen en cualquier instancia. Si Jeff agrega "Transferencia Bancolombia Cuenta Amparo", aparece en otra instancia que use el mismo schema/DB. Hoy es DB local PGlite por usuario, no es problema; cuando se migre a Postgres compartido si hubiera multi-tenant, lo es.

**Resolucion:** Batch 1. Agregar `paymentMethods.business_id` nullable. Filtros UI:

```sql
WHERE business_id IS NULL OR business_id = :currentBusinessId
```

Metodos globales existentes (efectivo, transferencia generica) quedan `business_id = NULL` y son visibles para todos. Metodos especificos del negocio se asocian a ese `business_id`.

**Estado:** cerrada a nivel query. Batch 1 (commit `26a3fe0`) agrega columna nullable. Batch 1.5 (commits `7a215ae` + `a392abf`) implementa el filter `IS NULL OR = :id` en `paymentMethods.list` via `ctx.activeBusinessId`, y `paymentMethods.create` persiste `business_id` desde el contexto activo. Sin backfill pendiente (los metodos existentes quedan globales por defecto, comportamiento deseable).

## Resumen tabular

| ID | Ubicacion | Severidad | Batch resolucion | Estado |
|---|---|---|---|---|
| DA-1 | `orders.ts:54` | alta | Batch 4 | abierta |
| DA-2 | `orders.ts` create flow | alta | Batch 3 (schema) + Batch 4 (descuento) | schema listo, descuento abierto |
| DA-3 | `orders.ts:123-133` | media | Batch 4 (via void) | abierta |
| DA-4 | `schema.ts customers` | media | Batch 1 + Batch 1.5 | mitigada (query layer) |
| DA-5 | `schema.ts paymentMethods` | baja | Batch 1 + Batch 1.5 | cerrada (query layer) |
| DA-6 | `schema.ts inventoryBalances` | media | post-PGlite (PostgreSQL real) | abierta |
| DA-7 | `schema.ts products.business_id` | media | Batch 4 (backfill + NOT NULL) | abierta |

## DA-6 — `inventory_balances` sin UNIQUE compound

**Ubicacion:** `src/lib/db/schema.ts` tabla `inventoryBalances`. La tupla `(business_id, location_id, product_id)` deberia ser unica pero no hay UNIQUE compound a nivel DB.

**Impacto:** Bajo PostgreSQL real con isolation `read-committed` (default), dos requests concurrentes que ajustan stock del mismo (location, product) y ambos miss en el SELECT inicial pueden insertar dos rows. La logica del router (`inventory.adjust`, `inventory.transfer`) usa SELECT-then-UPDATE-or-INSERT dentro de una `db.transaction`, lo cual mitiga pero NO elimina la race window.

Hoy es bug latente: PGlite es single-process, no hay concurrencia real. Cuando se migre a PostgreSQL real (Riesgo 1 del PLAN.md) se manifiesta.

**Resolucion:** Cuando se migre off PGlite a PostgreSQL real:

1. Agregar al schema migration `UNIQUE (business_id, location_id, product_id)` index.
2. Cambiar router a `INSERT ... ON CONFLICT DO UPDATE` para semantica atomica nativa.
3. Optional: extender `helpers.ts:tableToDDL` para emitir compound uniques (limitacion actual del helper documentada en codigo).

**Estado:** abierta. No-bloqueante mientras el deploy sea single-process PGlite. Bloqueante antes de piloto multi-PC con Postgres.

## DA-7 — `products.business_id` nullable transitorio

**Ubicacion:** `src/lib/db/schema.ts` tabla `products`, columna `business_id` agregada en Batch 3 como nullable.

**Impacto:** Productos legacy creados por demo seed.ts (sin business) coexisten con productos del business Jeff. Batch 4 (`orders.create` atomica) va a requerir que TODA venta de producto referencie un product cuyo `business_id` matchea el business activo. Productos con `business_id NULL` no van a poder venderse, lo cual es correcto operativamente, pero el schema deberia reforzarlo.

**Resolucion:** Batch 4. Pasos:

1. Backfill de `products.business_id` para productos del demo: asociarlos a un business "demo" o eliminarlos del path de venta.
2. Cambiar la columna a `NOT NULL`.
3. Validar en `orders.create` que `product.business_id == ctx.activeBusinessId`.

**Estado:** abierta. Transicional por diseno (Batch 3 dejo nullable a proposito para no romper demo seed).

## Convencion de cierre

Cuando una deuda se resuelve:

1. El commit que la cierra incluye `(closes DA-N)` en el cuerpo del mensaje.
2. Se agrega aqui una nueva fila al final del item: `**Cerrado:** commit `<sha>` en Batch N. <descripcion del fix real>.`
3. La fila en la tabla resumen pasa de `abierta` a `cerrada`.

No se borra el item original — queda como historial.

## Nuevas deudas

Si durante la implementacion aparecen bugs nuevos que no se pueden resolver inmediatamente:

1. Asignar siguiente ID disponible (DA-6, DA-7, ...).
2. Documentar aqui con la misma estructura.
3. Decidir batch de resolucion o marcar `pendiente de asignacion`.

No acumular deuda silenciosa en comentarios `// TODO` sueltos.
