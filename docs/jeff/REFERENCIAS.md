# Referencias Externas — FinOpenPOS Jeff

Este documento es input del Batch 0 del plan FinOpenPOS Jeff. Resume qué se inspeccionó de los proyectos de referencia en `/Users/abautixta/Dev/Jeff/oss/`, qué patrones adoptamos, qué patrones rechazamos, y bajo qué condiciones de licencia.

## Repos inspeccionados

| Repo | Stack | Licencia | Multi-sede nativo | Dominio |
|---|---|---|---|---|
| `oss/NexoPOS` | Laravel + Vue, MySQL | **GPLv3** | No (single-store) | POS general (retail/restaurant) |
| `oss/studio-crm` | Laravel 10 + Blade, MySQL | **MIT** | No (single-studio) | Tatuaje y piercing |
| `oss/FinOpenPOS` (base) | Next 16 + tRPC + Drizzle + PGlite | MIT | No (single-user) | POS minimalista |

## Reglas de uso por licencia

**NexoPOS — GPLv3:** patrones sí, código literal **no**. Copiar código fuente PHP a nuestro código TS contamina el fork con GPLv3 y nos obliga a publicar todo el código de Jeff bajo GPLv3. Política aplicada:

- Leer migraciones, modelos y servicios para entender decisiones de schema y orden de operaciones.
- Reescribir desde cero en TS/Drizzle.
- Documentar inspiración en comentarios: `// Pattern inspired by NexoPOS register lifecycle`.
- No copiar nombres exactos de tablas (ellos usan `nexopos_*`).

**studio-crm — MIT:** patrones y código sí, atribución obligatoria. Política aplicada:

- Si copiamos un fragmento, incluir nota MIT en el archivo destino.
- En general preferimos reescribir adaptado a Drizzle/TS, manteniendo nombres de campos similares cuando aporten claridad.

## Hallazgos clave por área del plan

### Caja por turno (Batch 2)

**Referencia: NexoPOS `nexopos_registers` + `nexopos_registers_history`.**

Patrón a adoptar (no estaba en el plan original):

- `cash_movements` (o equivalente) debe registrar `balance_before`, `balance_after`, `transaction_type` (`positive` | `negative` | `unchanged`).
- Beneficio: queries de saldo de caja en O(1) leyendo el último movimiento, sin sumar todo el ledger.
- Cada venta, refund, retiro manual o ingreso manual escribe una fila en el history con el balance running.

Patrón NexoPOS a evitar:

- NexoPOS guarda `balance` mutable directo en `nexopos_registers`. Eso requiere lock y rompe auditabilidad si alguien edita la fila. Nosotros mantenemos `cash_sessions.expected_cash_amount` calculado desde el ledger, no como campo mutable de fuente de verdad.

Diferencial Jeff:

- NexoPOS asocia caja a un usuario via `used_by`. Nosotros asociamos a `business_id` + `location_id` + `opened_by_user_id`. Eso permite cerrar caja por local sin importar qué cajero la abrió.

### Venta POS atómica (Batch 4)

**Referencia: NexoPOS `nexopos_orders` + `nexopos_orders_payments` + `nexopos_orders_products`.**

Patrones a adoptar (algunos ya en plan, otros nuevos):

1. **Multi-payment desde día 1.** `orders_payments` es 1:N con `orders` y soporta efectivo + transferencia + cualquier combo en la misma venta. NexoPOS no lo trata como feature avanzada, lo trata como estructura base. **Recomendación: implementar `paymentLines` con N=1+ desde Batch 4, no diferir como mencionaba el plan.**

2. **Snapshot completo en `order_items`.** NexoPOS guarda `name`, `unit_price`, `total_price`, `tax_value`, `total_purchase_price` (= unit_cost), `discount`, `procurement_product_id` (link al lote de compra). Confirma el patrón snapshot que el plan ya prevé.

3. **`payment_status` separado de `process_status`.** NexoPOS distingue:
   - `payment_status`: `paid` | `unpaid` | `partially_paid` (estado financiero)
   - `process_status`: `pending` | `ongoing` | `complete` (estado operativo)

   **Recomendación: agregar ambos campos a `orders` desde Batch 4.** Permite ventas a fiar / parciales sin retrabajo posterior.

4. **`total_cogs` en orden y `total_purchase_price` en línea.** Permite calcular margen sin joins ni recálculos. Adoptar.

5. **`tendered` (efectivo entregado) y `change` (vuelto).** Útil para ticket impreso y para cuadrar caja.

6. **`voidance_reason` text + `process_status: void`.** NexoPOS no borra órdenes, las anula con motivo. Resuelve la deuda DA-3 elegantemente: en lugar de DELETE, se hace UPDATE con motivo, y el ledger de inventory_movements registra el reverso.

Patrón a evitar:

- NexoPOS asume single-store: `nexopos_orders.register_id` es la única dimensión de scope físico. Nosotros agregamos `business_id` + `location_id` + `cash_session_id`.

### Inventario por local (Batch 3)

**Referencia: NINGUNO directamente útil.**

- NexoPOS tiene `nexopos_products_history` (ledger por producto) pero sin dimensión de location.
- studio-crm `inventory` es flat: solo `quantity` y `reorder_point`, sin ledger ni multi-store.

Diseño Jeff es propio:

- `inventory_balances(business_id, location_id, product_id, quantity_on_hand, quantity_reserved)` — cantidad disponible por local.
- `inventory_movements(business_id, location_id, product_id, quantity_delta, type, source_type, source_id)` — ledger.

NexoPOS confirma indirectamente que el ledger es el patrón correcto (lo tienen sin location). El gap multi-sede es lo que diferencia a Jeff.

### Gastos vs compras (Batch 6)

**Referencia: NexoPOS — patrón sólido. studio-crm — anti-patrón.**

NexoPOS separa correctamente:

- `nexopos_expenses` + `nexopos_expenses_categories` + `nexopos_expenses_history` (gasto operativo: arriendo, servicios).
- `nexopos_procurements` + `nexopos_procurements_products` (compra de mercaderia que entra al stock).

Adoptar esta separación literalmente.

studio-crm hace lo contrario: tabla `financial` flat con `type: payment | refund | expense | deposit`. Mezcla pagos de servicio con gastos operativos. **Anti-patrón para nuestro caso.** Confirma la decisión del plan de mantenerlos separados.

### Staff y roles (Batch 1 + 8)

**Referencia: studio-crm `staff` (MIT, copia adaptada permitida).**

studio-crm define:

```php
$table->enum('role', ['admin', 'manager', 'artist', 'receptionist'])->default('artist');
$table->decimal('commission_rate', 5, 2)->default(0.00);
$table->text('specialties')->nullable();
$table->boolean('active')->default(true);
```

Adopción para Jeff:

- Roles MVP: `owner` | `manager` | `cashier` | `artist`. Diferimos `receptionist` hasta que Jeff lo necesite.
- `commission_rate` decimal directo en `business_members` o en una tabla `staff_profiles` cuando llegue Batch 8. No en MVP de Batch 1.
- `specialties` → diferido a Batch 8.

Diferencial Jeff:

- studio-crm `staff` es global por studio. Nosotros lo modelamos como `business_members(user_id, business_id, role, status)` y, en Batch 8, `location_members(user_id, location_id, role, status)` para artistas que solo operan en una sede.

### Servicios de tatuaje y piercing (Batch 8)

**Referencia: studio-crm `services` (MIT, copia adaptada).**

studio-crm modela:

```php
$table->enum('type', ['tattoo', 'piercing', 'touchup', 'removal']);
$table->string('body_location', 100);
$table->text('machine_tools')->nullable();
$table->text('materials_used')->nullable();
$table->text('practitioner_notes')->nullable();
```

Adoptar casi 1:1 cuando llegue Batch 8, agregando:

- `business_id` + `location_id` (studio-crm no los tiene).
- `order_item_id` (link a la línea de venta donde se cobró el servicio).
- `cash_session_id` (link a la caja donde se registró).

### Fotos y expedientes (Capa 9)

**Referencia: studio-crm `service_photos` + `services.execution_photo_url`.**

studio-crm define:

```php
$table->enum('photo_type', ['before', 'during', 'after', 'healed']);
```

Adoptar el enum directo. Extender con campos que studio-crm no tiene:

- `consent_status` (`pending` | `granted` | `revoked`).
- `is_public` (boolean).
- `storage_provider` (`s3` | `r2` | `supabase`) — el plan exige storage durable, no filesystem.

### Compliance / waivers (Capa 9)

**Referencia: studio-crm `compliance` (MIT, copia adaptada).**

```php
$table->string('type', 50);
$table->date('log_date');
$table->json('details')->nullable();
$table->string('status', 20)->default('pass');
$table->foreignId('verified_by')->nullable()->constrained('staff');
```

Patrón directo para waivers de cliente y registros de esterilización. Adoptable casi sin cambios cuando llegue Capa 9.

## Ajustes propuestos al plan tras esta exploración

Estos ajustes deben confirmarse con Lex antes de tocar schema. Cada uno tiene impacto acotado.

### Ajuste 1 — `cash_movements` con balance running (Batch 2)

⚠️ Problema: el plan define `cash_movements` pero no especifica si lleva balance running.
Por qué: sin `balance_before` / `balance_after`, calcular saldo actual requiere sumar todo el ledger de la sesión. NexoPOS resuelve esto guardando ambos campos por movimiento.
Alternativa: agregar `balance_before`, `balance_after`, `transaction_type` a `cash_movements`.
Trade-offs: 3 columnas más por movimiento. Beneficio: queries de saldo en O(1) y auditoría más clara.

### Ajuste 2 — Multi-payment lines desde Batch 4 (no diferir)

⚠️ Problema: el plan dice "MVP puede limitar a un pago por venta, pero conviene que la estructura ya soporte varios pagos".
Por qué: NexoPOS demuestra que `orders_payments` 1:N no es feature avanzada, es base. Implementarlo limitado y después extender es retrabajo gratuito.
Alternativa: desde Batch 4, `paymentLines` como tabla 1:N con N>=1. UI en MVP puede mostrar solo un input pero estructura ya soporta múltiples.
Trade-offs: una tabla más en Batch 4 (`order_payments`) en lugar de campos en `orders`. Coste mínimo, evita migración futura.

### Ajuste 3 — `payment_status` + `process_status` en orders (Batch 4)

⚠️ Problema: el plan no separa estado financiero de estado operativo en órdenes.
Por qué: NexoPOS lo separa porque una venta puede estar `process_status: complete` pero `payment_status: partially_paid` (cliente debe el resto). Sin esta separación, no se puede modelar fiado o cuotas.
Alternativa: agregar ambos campos. `payment_status: paid | unpaid | partially_paid` y `process_status: pending | ongoing | complete | void`.
Trade-offs: 2 columnas más. Beneficio: ventas parciales y voids sin retrabajo.

### Ajuste 4 — Void en lugar de delete (resuelve DA-3)

⚠️ Problema: la deuda DA-3 plantea soft-delete o void de órdenes pero el plan no decide.
Por qué: NexoPOS demuestra el patrón completo: `process_status: void` + `voidance_reason` + `inventory_movements` reverso. Borrar órdenes con FK rota es un anti-patrón en POS.
Alternativa: en Batch 4, en lugar de soft-delete, implementar `orders.void` que marca la orden, registra motivo, crea movimientos reverso de inventario y de caja, y mantiene la fila para auditoría.
Trade-offs: la UI de "borrar" se vuelve "anular". Beneficio: cero pérdida de auditoría, cierre contable correcto.

### Ajuste 5 — Roles MVP `owner` (no `admin`)

studio-crm usa `admin`. El plan ya usa `owner`. Mantener `owner` porque es más preciso para multi-business: el owner del negocio es uno, los `manager` pueden ser varios. Confirmar.

### Ajuste 6 — `receptionist` diferido

studio-crm tiene rol `receptionist`. Útil pero no MVP. Diferir hasta que Jeff lo pida.

## Patrones que NO adoptamos

| Patrón | Origen | Razón |
|---|---|---|
| Tabla `financial` flat con `type` enum | studio-crm | Mezcla pagos de venta con gastos. Reduce claridad contable. |
| `inventory.quantity` global sin location ni ledger | studio-crm | Single-store. No escala a Amparo + Britalia. |
| `nexopos_registers.balance` como campo mutable | NexoPOS | Anti-patrón de auditoría. Calcular desde ledger. |
| `nexopos_orders.register_id` como única dimensión de scope físico | NexoPOS | Asume single-store. Necesitamos `business_id` + `location_id`. |
| Naming `nexopos_*` en tablas | NexoPOS | Nuestro fork no es NexoPOS. Naming limpio. |

## Referencias futuras (cuando lleguen Batches posteriores)

Cuando llegue cada batch, vale la pena releer:

- **Batch 3 (inventario):** `oss/NexoPOS/database/migrations/create/2020_06_20_000000_create_products_history_table.php` — patrón de history ledger por producto.
- **Batch 6 (gastos/compras):** `oss/NexoPOS/database/migrations/create/2020_06_20_000000_create_procurements_*` y `create_expenses_*` — separación que vamos a portar.
- **Batch 8 (staff/servicios):** `oss/studio-crm/database/migrations/2025_01_20_000004_create_services_table.php` — reescribir adaptado.
- **Capa 9 (fotos/waivers):** `oss/studio-crm/app/Models/ServicePhoto.php` y `Compliance.php` — adoptar patrón con extensiones de consent y storage durable.

## Conclusión operativa

Los repos de referencia confirman que el plan está bien orientado y que ningún competidor open-source resuelve el caso multi-sede que necesita Jeff. Los ajustes propuestos son refinamientos basados en patrones probados, no replanteos.

**No hay razón para diferir Batch 0 + Batch 1.** Procedemos con el git baseline y arrancamos.
