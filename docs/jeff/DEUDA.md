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

**Estado:** abierta. Se mitiga en Batch 1.

## DA-5 — `paymentMethods` no tiene scope de negocio

**Ubicacion:** `src/lib/db/schema.ts` — tabla `paymentMethods` es global, sin `user_uid` ni `business_id`.

**Impacto:** todos los metodos de pago aparecen en cualquier instancia. Si Jeff agrega "Transferencia Bancolombia Cuenta Amparo", aparece en otra instancia que use el mismo schema/DB. Hoy es DB local PGlite por usuario, no es problema; cuando se migre a Postgres compartido si hubiera multi-tenant, lo es.

**Resolucion:** Batch 1. Agregar `paymentMethods.business_id` nullable. Filtros UI:

```sql
WHERE business_id IS NULL OR business_id = :currentBusinessId
```

Metodos globales existentes (efectivo, transferencia generica) quedan `business_id = NULL` y son visibles para todos. Metodos especificos del negocio se asocian a ese `business_id`.

**Estado:** abierta. Se mitiga en Batch 1.

## Resumen tabular

| ID | Ubicacion | Severidad | Batch resolucion | Estado |
|---|---|---|---|---|
| DA-1 | `orders.ts:54` | alta | Batch 4 | abierta |
| DA-2 | `orders.ts` create flow | alta | Batch 3 + Batch 4 | abierta |
| DA-3 | `orders.ts:123-133` | media | Batch 4 (via void) | abierta |
| DA-4 | `schema.ts customers` | media | Batch 1 | abierta |
| DA-5 | `schema.ts paymentMethods` | baja | Batch 1 | abierta |

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
