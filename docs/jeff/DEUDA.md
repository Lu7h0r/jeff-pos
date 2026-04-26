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

**Estado:** cerrada. Commit `9f0854f` (Batch 4) reescribe `orders.create` como transaccion atomica que computa `total = sum(unit_price * quantity)` leyendo desde DB, ignorando cualquier total del cliente. Validacion `sum(paymentLines.amount) === computed_total` o BAD_REQUEST.

## DA-2 — `orders.create` nunca descuenta stock

**Ubicacion:** `src/lib/trpc/routers/orders.ts` — todo el flujo de `create`. No existe ningun `update` sobre `products.in_stock` ni sobre tabla de inventario.

**Impacto:** `products.in_stock` nunca baja tras una venta. La UI valida stock client-side pero el servidor no hace nada. **El inventario esta corrupto desde el primer dia de uso real.** Hoy `in_stock` es decorativo.

**Resolucion:** Batch 3 introduce `inventory_balances` + `inventory_movements`. Batch 4 hace que `orders.create` cree movimientos `sale` y actualice `inventory_balances` dentro de la misma transaccion DB que crea la orden, validando `quantity_on_hand >= requested` con condicion atomica para evitar stock negativo por carrera.

**Estado:** cerrada. Commit `9f0854f` (Batch 4) implementa el `UPDATE inventory_balances SET quantity_on_hand = quantity_on_hand - :qty WHERE id = :id AND quantity_on_hand >= :qty RETURNING *` con guarda atomica. Si returning vacio, throw CONFLICT "Insufficient stock". `orders.create` crea fila `inventory_movements` type=`sale` por cada linea, source_type=`order`, source_id=order.id. `products.in_stock` legacy queda sin actualizar — es decorativo y se elimina en futuro batch de cleanup.

## DA-3 — `orders.delete` tiene FK bug con transactions

**Ubicacion:** `src/lib/trpc/routers/orders.ts:123-133`. Borra `orderItems` y luego `orders`. Pero `transactions.order_id` tiene FK a `orders.id`. Si existe transaccion, el delete falla con error de FK.

**Test que documenta el bug:** `src/lib/trpc/routers/__tests__/orders.test.ts:200-215`.

**Impacto:** una orden con cobro registrado no se puede borrar via UI. Hoy es bug pasivo (la UI rara vez intenta borrar). Cuando la operacion real arranque, el patron de "borrar venta" debe estar resuelto.

**Resolucion:** Batch 4. **No** se implementa soft-delete ni se arregla el delete actual. En su lugar se introduce el patron `orders.void` (inspirado en NexoPOS):

- `orders.process_status` agrega valor `void`.
- `orders.voidance_reason` text nullable.
- `orders.voided_at` timestamp nullable.
- `orders.voided_by_user_id` text nullable, FK a user.
- mutation tRPC `orders.void` marca la orden, crea `inventory_movements` reverso (devuelve stock al local), crea `cash_movements` reverso (revierte efecto en caja del turno).
- la fila nunca se borra. Se mantiene para auditoria contable.

La UI cambia "Borrar venta" → "Anular venta" con motivo obligatorio.

**Estado:** cerrada. Commit `9f0854f` (Batch 4) elimina `orders.delete` completamente y agrega `orders.void` con mutation que en una sola transaccion: marca process_status=`void`, registra voidance_reason+voided_at+voided_by_user_id, crea inventory_movements reverso (type=`adjustment`, quantity_delta positivo, source_type=`order_void`), crea cash_movements reverso (type=`refund`, amount negativo, transaction_type=`negative`). Rejection: void en orden ya void = CONFLICT, void en cash_session cerrada = CONFLICT con mensaje guia.

## DA-4 — `customers` no tiene `business_id`

**Ubicacion:** `src/lib/db/schema.ts` — tabla `customers` aisla por `user_uid` (Better Auth user).

**Impacto:** cuando haya empleados (cashier, artist), cada uno ve solo los clientes que el mismo creo. La cliente que llega a Britalia atendida por un cashier no la ve el manager que entra desde Amparo. Modelo incompatible con el negocio Jeff.

**Resolucion:** Batch 1. Agregar columna `customers.business_id` nullable. Migracion en dos pasos:

1. Batch 1: agregar columna nullable, dejar `user_uid` intacto. Routers filtran por `business_id IS NOT NULL ? = :businessId : user_uid = :userId` (fallback temporal).
2. Batch 2 o 3: backfill de `business_id` desde memberships del `user_uid` correspondiente, hacer NOT NULL, eventualmente quitar dependencia de `user_uid` para customers.

**Estado:** mitigada a nivel query.

**Cerrado parcial:** commit `26a3fe0` (Batch 1) agrega columna nullable. Commits `7a215ae` + `a392abf` (Batch 1.5) introducen `resolveActiveContext` y migran `customers.list`/`customers.create` a usar `ctx.activeBusinessId` con fallback `user_uid`. Pendiente final: backfill de datos existentes y NOT NULL en futuro batch (no urgente; el filter OR funciona bien para datos legacy).

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
| DA-1 | `orders.ts:54` | alta | Batch 4 | cerrada |
| DA-2 | `orders.ts` create flow | alta | Batch 3 (schema) + Batch 4 (descuento) | cerrada |
| DA-3 | `orders.ts:123-133` | media | Batch 4 (via void) | cerrada |
| DA-4 | `schema.ts customers` | media | Batch 1 + Batch 1.5 | mitigada (query layer) |
| DA-5 | `schema.ts paymentMethods` | baja | Batch 1 + Batch 1.5 | cerrada (query layer) |
| DA-6 | `schema.ts inventoryBalances` | media | post-PGlite (PostgreSQL real) | abierta |
| DA-7 | `schema.ts products.business_id` | media | Batch 4 (backfill + NOT NULL) | cerrada |
| DA-8 | `orders.update` mutation | media | Batch 5 | cerrada |
| DA-9 | `paymentMethods` lacks is_cash flag | baja | TBD (futuro batch payment-methods) | abierta |
| DA-10 | `orders.status` legacy column | baja | cleanup-da10-da11 | cerrada |
| DA-11 | `transactions` row paralelo en orders.create | media | cleanup-da10-da11 | cerrada |
| DA-12 | weighted-average cost no implementado | media | TBD (post-pilot real) | abierta |
| DA-13 | `purchases.cancel` con sesion cerrada sin reversa | media | TBD | abierta |
| DA-14 | `expense_entries` sin void | media | TBD | abierta |
| DA-15 | `resolveActiveContext` no consulta `location_members` | media | auth-management | cerrada |
| DA-16 | POS service attachment no transaccional con orders.create | media | TBD | abierta |
| DA-17 | Splits de comision hardcoded en helper | baja | TBD | abierta |
| DA-18 | Workstation availability sin vista calendario | baja | UX futuro | abierta |
| DA-19 | Commission policy snapshot sin recompute pre-liquidacion | baja | UX futuro | abierta |
| DA-20 | `team.invite` retorna password en texto plano | media | TBD (post Better Auth invite tokens) | abierta |
| DA-21 | Multi-business switcher UI no existe | baja | UX futuro | abierta |
| DA-22 | Exclusividad broad/granular sin enforcement DB | baja | post-Postgres real | abierta |
| DA-23 | Generacion de password hardcoded, no via Better Auth reset | media | TBD | abierta |
| DA-24 | Archive del ultimo owner posible (lockout risk) | alta | auth-cleanup | cerrada |
| DA-25 | Routers de inventory/orders/dashboard no auditados con effectiveLocationIds | media | auth-cleanup | cerrada |

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

**Estado:** cerrada. Commit `71d94d3` cambia schema a `NOT NULL`. Commit `3f4ae9e` actualiza `seed.ts` (demo) para crear "Demo Business" + membership + location, y assignar todos los productos/customers/orders al business. `orders.create` valida `product.business_id === ctx.activeBusinessId` o falla. Migracion break: hay que correr `rm -rf data/pglite && bun run dev` para recrear la DB local (acceptable porque Jeff no esta deployado).

## DA-8 — `orders.update` es escape hatch sin audit trail

**Ubicacion:** `src/lib/trpc/routers/orders.ts`, mutation `orders.update`. Sobrevive en Batch 4 como opcion partial admin para mantener vivo el modal de edicion en `src/app/admin/orders/page.tsx`.

**Impacto:** un usuario miembro del business puede modificar `status` (legacy), `total_amount` u otros campos de cualquier orden via UI sin que quede registro de quien lo hizo ni cuando ni por que. Bypassa el state machine de `process_status` (pending/ongoing/complete/void) que `orders.create` y `orders.void` enforzan correctamente. Riesgo contable: alguien puede editar el total de una venta cerrada y desbalancear la caja del dia.

**Resolucion:** Batch 5 (dashboard refactor) o batch dedicado a admin orders. Reemplazar `orders.update` con mutations explicitas y auditables:

- `orders.editNotes` (solo notes, registrar editor + timestamp)
- `orders.markPartialPayment` (cambiar payment_status a partially_paid agregando un order_payment con motivo)
- eliminar la edicion de `total_amount` y `status` legacy desde UI; cualquier cambio de monto/estado pasa por void + nueva venta.

Cuando dashboard.stats migre a leer `process_status` en lugar de `status` legacy, se puede retirar el modal de edicion de admin/orders y matar `orders.update` de raiz.

**Estado:** cerrada. Commits `4a3bd1e` + `c7d3f8e` (Batch 5) eliminan `orders.update` completamente del router y reemplazan el modal de admin/orders con un editor solo de `notes` via `orders.editNotes`. `grep -r 'orders\.update'` queda vacio en `src/`. `markPartialPayment` se difiere hasta que haya un caso real (Jeff hoy no tiene clientes a fiar formalizados).

## DA-9 — `paymentMethods` carece de flag `is_cash` o taxonomia tipada

**Ubicacion:** `src/lib/trpc/routers/orders.ts`, en el flow de `orders.create` y `orders.void`. Para decidir si un payment va a `cash_sessions.expected_cash_amount` vs `expected_digital_amount`, el codigo infiere por nombre del metodo:

```ts
const isCash = paymentMethod.name.toLowerCase().includes("cash");
```

**Impacto:** funciona para los seeds actuales (`Cash`, `Credit Card`, `Debit Card`) y para los que el seed jeff cree. Pero cuando el operador real cree un metodo "Efectivo", "Caja chica", "Plata en mano", el inferidor falla y todos los pagos en efectivo van a digital. Caja del dia se desbalancea silenciosamente.

**Resolucion:** futuro batch (idealmente cuando se implemente CRUD propio de payment_methods con UI). Opciones:

1. Agregar columna `is_cash` boolean (simple, retrocompatible).
2. Reemplazar por `kind` enum: `cash | card | transfer | other` (mas extensible, mejor para reportes).

Recomendacion: opcion 2. El reporte de `dashboard.stats` puede separar mejor por kind.

**Estado:** abierta. No-bloqueante mientras el seed controle los nombres. Critico antes de dejar a Jeff crear payment methods libremente.

## DA-10 — `orders.status` legacy column sin uso

**Ubicacion:** `src/lib/db/schema.ts` tabla `orders`, columna `status` varchar(20). Valores legacy: `completed`, `pending`, `cancelled`.

**Impacto:** En Batch 4 se introdujo `process_status` (pending/ongoing/complete/void) como source of truth. Batch 5 migro dashboard y admin/orders/page.tsx a leer `process_status`. Pero `orders.create` sigue escribiendo `status="completed"` para compatibilidad con codigo legacy que ya no existe. Es un campo zombie: ocupa espacio, agrega ruido al schema y puede confundir al proximo developer.

**Resolucion:** post-Batch 6, batch de cleanup tecnico junto con DA-11. Pasos:

1. `grep -r 'orders\.status' src/` para confirmar que nadie lee mas la columna legacy.
2. Quitar el insert de `status` desde `orders.create`.
3. UPDATE bulk de rows existentes (NULL them).
4. Drop column en proxima migracion (cuando se decida usar Drizzle migrate formal).

**Estado:** abierta. No-bloqueante.

## DA-11 — `transactions` row paralelo en `orders.create`

**Ubicacion:** `src/lib/trpc/routers/orders.ts` lineas 453-464 (aprox), bloque que inserta en `transactions` por compat-back con dashboard viejo.

**Impacto:** Cada `orders.create` escribe TANTO en `order_payments` (Batch 4) COMO en `transactions` (legacy). El nuevo `dashboard.stats` (Batch 5) ya no lee de `transactions`. La doble escritura:

- Dilata la transaction de venta atomica innecesariamente.
- Genera datos contables redundantes que pueden divergir.
- Mantiene viva una tabla que deberia retirarse o repurposearse para egresos manuales.

**Resolucion:** post-Batch 6, batch de cleanup tecnico junto con DA-10. Decidir destino de `transactions`:

- Opcion A: retirar completamente. `expense_entries` (Batch 6) cubre egresos. `cash_movements` (Batch 2) cubre flujo de caja. `order_payments` cubre pagos de venta. La tabla `transactions` no aporta nada nuevo.
- Opcion B: mantener solo para integraciones futuras (importacion bancaria, conciliacion).

Recomendacion: A. La eliminacion incluye drop column `payment_method_id` en transactions, drop FKs, drop tabla, ajustar tests.

**Estado:** abierta. No-bloqueante. Bloqueante para perf si Jeff opera muchas ventas/dia (cada venta hace 2x writes redundantes).

## DA-12 — Weighted-average cost no implementado en `purchases.receive`

**Ubicacion:** `src/lib/trpc/routers/purchases.ts`, en el flow de `purchases.receive`.

**Impacto:** Cuando se recibe una compra, `products.cost_amount` se sobrescribe con el `unit_cost` del item recibido (most-recent-purchase-price). Si Jeff compra el mismo producto a precios distintos en una semana:

- Costo unitario en venta (`order_items.unit_cost` snapshot) refleja solo la ultima compra, no el promedio ponderado del stock real.
- COGS calculado en dashboard se desvia del COGS real cuando hay volatilidad de costos.
- Margen mostrado puede ser engañoso.

**Resolucion:** TBD post-pilot real. Implementar weighted-average:

```
new_avg = (existing_qty * existing_cost + received_qty * received_cost) / (existing_qty + received_qty)
```

Requiere actualizar `inventory_balances` con un `avg_cost_amount` o recalcular desde `inventory_movements`.

**Estado:** abierta. No-bloqueante para Jeff hoy (precios estables esperados). Reportar a Jeff cuando se note discrepancia P&L vs realidad.

## DA-13 — `purchases.cancel` con sesion cerrada queda sin reversa contable

**Ubicacion:** `src/lib/trpc/routers/purchases.ts`, mutation `purchases.cancel`.

**Impacto:** Si la cash_session que pago la compra ya cerro (`status="closed"`), cancelar la PO marca `status="cancelled"` pero NO escribe la reversa en cash_movements (no se puede tocar ledger cerrado). Resultado: la caja del dia que se cerro tiene un cash_movements de salida (manual_out por la compra) que en realidad fue cancelada → diferencia contable silenciosa.

**Resolucion:** TBD. Dos opciones:

A. Prohibir cancelar PO con cash_session cerrada (CONFLICT). Forzar la cancelacion solo durante la sesion activa.
B. Escribir la reversa en la sesion abierta CURRENT de la misma location (compensacion el dia siguiente). Documentar al operario que la diferencia se ve en la sesion del dia siguiente.

Recomendacion: A para MVP (mas estricto, evita confusion). B requiere training operativo.

**Estado:** abierta. Riesgo contable real cuando Jeff cancele una PO al dia siguiente.

## DA-14 — `expense_entries` no tiene void / correccion auditable

**Ubicacion:** `src/lib/trpc/routers/expenses.ts`. No existe `expenses.entries.void`.

**Impacto:** Si Jeff registra un gasto mal (monto incorrecto, categoria errada, gasto duplicado), no hay forma de revertirlo desde el router. El operario tendria que ir a la DB directamente — anti-patron en POS.

**Resolucion:** Mismo patron que `orders.void`:

- agregar columnas `voided_at`, `voided_by_user_id`, `voidance_reason` a `expense_entries`.
- nueva mutation `expenses.entries.void({ entryId, voidanceReason })`.
- si el entry fue paid via cash_session, escribir reversa en cash_movements (manual_in con transaction_type=positive) si la sesion esta abierta. Si esta cerrada, aplicar la misma decision que DA-13.

**Estado:** abierta. Probable bloqueante operativo cuando Jeff arranque a usar gastos en serio.

## DA-15 — `resolveActiveContext` no consulta `location_members`

**Ubicacion:** `src/lib/trpc/active-context.ts`. Resolver de Batch 1.5.

**Impacto:** Batch 8 introdujo `location_members` para granularidad por sede (un cashier que solo opera en Britalia). El resolver actual lee solo `business_members` y deriva `activeRole` desde ahi. Resultado: si un usuario tiene `business_members.role=cashier` Y `location_members(britalia).role=artist`, el sistema lo trata como cashier en TODAS las locations en lugar de respetar el rol granular en Britalia. La proteccion hoy es solo via UI (selector de cookie), no por backend.

**Resolucion:** post-Batch 8, sumar consulta a `location_members` cuando `locationId` esta resuelto. Si existe membership granular activa para esa location, sobrescribe el role en el contexto. Si no, usa el role del business membership.

**Estado:** cerrada. Commit `40c7b32` (auth-management) reescribe `resolveActiveContext`:

- Si user tiene `business_members` activo → broad scope (acceso a todas las locations del business).
- Si user solo tiene `location_members` → granular scope (limitado a esos locationIds).
- `effectiveLocationIds: number[]` expuesto en ctx para que routers filtren.
- `isLocationScoped: boolean` flag para distinguir escenarios.
- Tests `active-context.test.ts` cubren broad vs granular vs sin membership vs data integrity (cross-business locations).

Complementado con `role-guards.ts` (middleware `requireRole` + presets ownerOnly/ownerOrManager/operationalRole/artistOrAbove) aplicado a 13 routers en commit `9efa185`. UI `/admin/team` (commits `60ec8ff` + `330657e`) permite invitar/listar/cambiar role/archivar miembros. `admin-layout.tsx` filtra nav segun role (`2801be5`).

## DA-16 — POS service attachment no es transaccional con `orders.create`

**Ubicacion:** `src/app/admin/pos/page.tsx` + `src/lib/trpc/routers/services.ts`.

**Impacto:** En Batch 8, attachear un servicio (staff + commission_estimate) a una linea de orden ocurre POST-`orders.create` via mutacion separada. Si la mutation de attach falla, queda la orden creada sin el service_sale → no hay comision estimada para esa venta. El operario ve toast de error pero no hay reintento ni cola.

**Resolucion:** Migrar a una mutation compuesta `orders.createWithServices` que reciba items + paymentLines + serviceAttachments en un solo input y haga TODO en una sola transaction. O mantener separado pero agregar reintento client-side con backoff.

**Estado:** abierta. UI muestra error claro, operario puede intentar attach manual desde admin/orders, pero hay riesgo de que se olvide y la comision quede invisible.

## DA-17 — Splits de comision hardcoded en helper

**Ubicacion:** `src/lib/trpc/commission-split.ts`. Tres opciones predefinidas (30/70, 50/50, 70/30) + owner_direct + manual.

**Impacto:** Si Jeff acuerda 40/60 con un artista nuevo, no hay forma de configurarlo sin tocar codigo. Workaround: `manual` queda en cero hasta liquidacion humana. Funciona, pero pierde la utilidad de la estimacion automatica.

**Resolucion:** crear tabla `commission_splits(business_id, name, staff_basis_points)` y `staff_members.split_id` FK opcional que sobreescribe `default_split`. Splits configurables por business sin tocar codigo.

**Estado:** abierta. Bloqueante operativo solo si Jeff tiene staff con splits no estandar.

## DA-18 — Workstation availability sin vista calendario

**Ubicacion:** `src/app/admin/station-rentals/page.tsx`.

**Impacto:** Lista plana agrupada por dia. Operario no ve "Cabina 1 esta libre 14-18h" sin scrollear. Para piloto rapido alcanza, para uso real Jeff necesita ver disponibilidad continua.

**Resolucion:** integrar libreria de calendario (FullCalendar / react-big-calendar) cuando haya volumen real de bookings. UX no funcional.

**Estado:** abierta. No-bloqueante.

## DA-19 — Commission policy snapshot sin recompute pre-liquidacion

**Ubicacion:** `src/lib/trpc/routers/services.ts`.

**Impacto:** Si Jeff cambia `staff_members.default_split` despues de attachear un servicio, `commission_estimates` ya creado conserva el split viejo (correcto: snapshot inmutable). Pero no hay UI para "recalcular esta estimacion porque la situacion del staff cambio" antes de liquidar — el manager tiene que voidear la estimacion vieja y crear una nueva manual.

**Resolucion:** endpoint `services.commissions.recompute({ commissionEstimateId })` que tome el split actual del staff y reemplace los amounts. Solo permitido en estado `estimated` (no en `liquidated`).

**Estado:** abierta. UX de matiz, no critico.

## DA-20 — `team.invite` retorna password en texto plano

**Ubicacion:** `src/lib/trpc/routers/team.ts` mutation `team.invite`.

**Impacto:** Para invitar un miembro nuevo, el endpoint genera password 14-char base64 y lo retorna ONCE en la response. El inviter (owner/manager) lo ve en pantalla y se lo pasa al invitado por WhatsApp/email/etc. Plain-text password en transito sobre canales no encriptados es riesgo de seguridad real.

**Resolucion:** TBD. Migrar a magic-link / token de invitacion:

1. `team.invite` genera token de un solo uso, guardado encriptado en una tabla `invitations` con expiry.
2. Email-invite con link `https://app.jeff.studio/invite/<token>`.
3. Invitado abre link, el frontend hace `team.acceptInvite(token, newPassword)` y crea su propia password.
4. Fuera de banda nunca pasa la password.

Requiere Better Auth feature de invite tokens o implementacion custom. Fuera de scope MVP.

**Estado:** abierta. Aceptable mientras Jeff invite a su equipo conocido cara-a-cara.

## DA-21 — Multi-business switcher UI no existe

**Ubicacion:** `src/lib/trpc/active-context.ts`. Hardcoded a "oldest active membership".

**Impacto:** Si vos sos miembro de Jeff Studio Y de otro negocio (ej: Lex consulta), el sistema te asigna deterministicamente el mas viejo. No hay UI para alternar.

**Resolucion:** UX futuro. Componente similar al LocationSelector pero para business: dropdown en header (cuando user tiene >1 business membership), persiste cookie `jeff_active_business_id`, modifica `resolveActiveContext` para honrar el hint.

**Estado:** abierta. No-bloqueante mientras el usuario solo tenga 1 negocio.

## DA-22 — Exclusividad broad/granular sin enforcement DB

**Ubicacion:** `business_members` y `location_members` tables. Hoy no hay constraint que prevenga que el mismo user_id tenga rows en ambas para el mismo business_id.

**Impacto:** El codigo enforza la regla en `team.invite` (CONFLICT si ya existe membership opuesta) y en el resolver (broad gana sobre granular). Pero un INSERT directo en DB (drizzle studio, psql, migracion bug) puede crear el estado inconsistente.

**Resolucion:** Cuando se migre a PostgreSQL real:

1. CHECK constraint o trigger que verifique al insertar `business_members` o `location_members` que no haya rows existentes opuestas para ese (user, business).
2. Documentar en schema.sql.

**Estado:** abierta. Bug latente con probabilidad baja en single-process PGlite.

## DA-23 — Password generado hardcoded, no via Better Auth reset token

**Ubicacion:** `team.ts` line ~XX (donde se genera `randomBytes(...).toString('base64url').slice(0,14)`).

**Impacto:** Better Auth tiene flujo standard de password reset. Estamos bypaseando para el caso de invitacion porque Better Auth no tiene invite-token nativo. Pero la generacion local:

- No hashing como hace Better Auth internamente (la password se inserta directo en BD via signUpEmail, lo cual SI hashea).
- Pero la password en si nace en nuestro codigo, no en Better Auth.

**Resolucion:** Cuando Better Auth agregue invite tokens (o se implemente plugin), migrar a ese flujo. Mientras tanto el actual es funcional pero no ideal.

**Estado:** abierta. Funciona pero con superficie de ataque mas grande de lo necesario.

## DA-24 — Archive del ultimo owner permite lockout

**Ubicacion:** `team.archive` mutation en `team.ts`. Hoy no valida que quede al menos 1 owner activo en el business.

**Impacto:** Si Jeff archiva al unico owner remaining (vos), el business queda sin nadie con permisos full. Nadie puede invitar nuevos owners. Lockout total — solo recuperable via DB directa.

**Resolucion:** Validacion en `team.archive`:

1. Antes de set status="removed", contar owners activos restantes del business.
2. Si el target es owner Y count - 1 == 0, throw CONFLICT "Cannot archive the last active owner".

Tres lineas de codigo. Alta prioridad.

**Estado:** cerrada. Branch `chore/auth-cleanup-da24-da25`: `team.archive` ahora corre dentro de una `db.transaction` que cuenta los owners activos del business y rechaza con CONFLICT cuando la fila a archivar es el ultimo `business_members.role='owner'` con `status='active'`. Suspended/removed owners no cuentan. La regla solo aplica a `business_members`; archive de `location_members` siempre procede. Tests `team-lockout.test.ts` cubren los 5 escenarios (no-last / last / suspended-no-vale / no-owner / cross-business).

## DA-25 — Routers no auditados con `effectiveLocationIds`

**Ubicacion:** `inventory.ts`, `orders.ts`, `dashboard.ts`, posiblemente otros.

**Impacto:** El nuevo `ctx.effectiveLocationIds` (lista de locations que el granular user puede operar) se usa correctamente en `locations.list`. Pero rutas que reciben `locationId` como input y validan con `ctx.activeBusinessId` pueden NO chequear que ese `locationId` este en `effectiveLocationIds` del user.

Resultado practico: un cashier de Britalia podria pasar manualmente `locationId=amparo_id` al `dashboard.stats` o `inventory.balancesByLocation` y obtener data de Amparo. La gate UI lo restringe pero la API no.

**Resolucion:** audit pass por todos los routers que reciben `locationId`. Patron correcto:

```ts
if (ctx.isLocationScoped && !ctx.effectiveLocationIds.includes(input.locationId)) {
  throw new TRPCError({ code: "FORBIDDEN" });
}
```

Aplicar consistentemente. ~30 min de subagente.

**Estado:** cerrada. Branch `chore/auth-cleanup-da24-da25`: nuevo helper `src/lib/trpc/scope-guards.ts:assertLocationAllowed(ctx, locationId)` rechaza FORBIDDEN cuando `ctx.isLocationScoped && !ctx.effectiveLocationIds.includes(locationId)`. Aplicado en los 10 routers que reciben `locationId` (input directo o derivado de fila): `inventory` (balancesByLocation/adjust/transfer/movements), `orders` (create/get/void/editNotes + filtro de scope en `list`), `dashboard.stats` (input.locationId + scope implicito en aggregates cuando granular), `cash-sessions` (open/current/close), `expenses.entries` (create/list, scope implicito), `purchases` (create/list/receive/cancel), `services` (attachToOrderItem via order.location_id, list + scope implicito), `station-rentals` (create via workstation.location_id, list/markCompleted/cancel), `workstations` (list + scope implicito, create/update/archive via row.location_id), `locations.getActive` ya cubria via scopedLocationIds. Tests en `scope-guards.test.ts` (10 cases).

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
