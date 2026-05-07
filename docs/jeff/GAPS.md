# GAPS — FinOpenPOS Jeff

Cruce entre requisitos del negocio (extraídos de `cursor_local_amparo_business_overview.md` + `dominio_tatuajes_jeff.plan.md`) y el estado real del código.

Última revisión: 2026-05-07

---

## ✅ Implementado (schema + router + UI)

| Feature | Tablas | Router | Página admin |
|---------|--------|--------|-------------|
| Multi-negocio + sedes (Amparo/Britalia) | `businesses`, `locations`, `business_members`, `location_members` | `businesses`, `locations`, `location-members` | parcial (settings) |
| Catálogo de productos (costo, precio, fotos URL, kind) | `products` | `products` | `/admin/products` |
| Inventario por sede (ledger) | `inventory_balances`, `inventory_movements` | `inventory` | `/admin/inventory` |
| Órdenes de compra a proveedores | `purchase_orders`, `purchase_items`, `suppliers` | `purchases`, `suppliers` | `/admin/purchases`, `/admin/suppliers` |
| Caja por turno (abrir/cerrar/arqueo) | `cash_sessions`, `cash_movements` | `cash-sessions` | `/admin/cashier` |
| Venta POS atómica (descuenta stock, valida caja, void) | `orders`, `order_items`, `order_payments` | `orders` | `/admin/pos`, `/admin/orders` |
| Métodos de pago (efectivo/digital) | `payment_methods` | `payment-methods` | `/admin/payment-methods` |
| Gastos operativos por sede | `expense_categories`, `expense_entries` | `expenses` | `/admin/expenses` |
| Staff y comisiones estimadas | `staff_members`, `commission_estimates` | `staff` | `/admin/staff` |
| Estaciones de trabajo | `workstations` | `workstations` | `/admin/workstations` |
| Alquiler de estaciones a guest artists | `station_rentals` | `station-rentals` | `/admin/station-rentals` |
| Ventas de servicio (tatuaje, piercing, etc.) | `service_sales` | `services` | sin página propia |
| Clientes | `customers` | `customers` | `/admin/customers` |
| Dashboard (ventas, caja, inventario) | — | `dashboard` | `/admin` |
| Team/permisos | `business_members` | `team` | `/admin/team` |

---

## ⚠️ En schema pero incompleto

### `service_sales` — sin página admin propia
- Router `services.ts` existe.
- No hay `/admin/services` — los service_sales se crean desde el POS al vender un item con `kind=service`.
- **Falta:** UI de historial de servicios por staff, filtro por tipo, reporte de commission_estimates pendientes.

### `commission_estimates` — estimación solo, sin reglas automáticas
- La tabla calcula `staff_share_amount` / `house_share_amount` pero las **reglas de negocio no están automatizadas**:
  - Jeron 50% del 70% house share → **no implementado**
  - Perforaciones >4/día = 3.000 COP/perforación → **no implementado** (lógica está documentada pero no en código)
  - Jeff 100% si tatúa él → `commission_split` snapshot pero sin tipo "jeff_full"
- Las liquidaciones son manuales (status: estimated → liquidated por owner).
- **Falta:** reglas de comisión configurables, reporte de liquidaciones por período.

### `expense_entries` — sin recurrencia
- Gastos se registran one-off.
- **Falta:** plantillas de gastos recurrentes (arriendo, luz, internet de Amparo/Britalia con monto + frecuencia mensual/bimestral).

### `service_sales.materials_used` — campo texto, no estructura
- `materials_used: text` — free text.
- **Falta:** tabla `service_kits` o `service_templates` que define qué insumos (y cantidades) se consumen por tipo de servicio (ej. tatuaje mediano = 2 agujas + 1 cartucho tinta + 3 gasas). Hoy el consumo de inventario no se desagrega por servicio.

### `service_sales` — sin duración ni fotos
- No tiene `duration_minutes` (útil para analítica de productividad y descuentos futuros).
- No hay tabla `service_media` (fotos del tatuaje por tipo: referencia, stencil, proceso, resultado).
- **Falta:** ambos campos/tablas.

---

## ❌ No existe (cero en codebase)

### Agenda / appointments
- **Qué necesita Jeff:** agenda interna por local, estación, tatuador y cliente. No portal público todavía.
- **Por qué es importante:** saber qué estación está ocupada, cuándo, por quién. Guest artists, turnos, bloqueos.
- **Tablas a crear:** `appointments` (`business_id`, `location_id`, `workstation_id`, `staff_member_id`, `customer_id`, `start_at`, `end_at`, `status`, `notes`, `service_kind`).
- **Prioridad:** media — sin esto sigue funcionando el POS, pero Jeff no puede ver su agenda.

### Fotos del servicio (service_media)
- **Qué necesita Jeff:** subir fotos después de cerrar la venta (sin editar la venta). Tipos: referencia, stencil, proceso, resultado. Estados: interna, compartible, pública.
- **Taxonomía de tatuajes:** estilo (realismo, blackwork, fine line, lettering, cover up, neotradicional), color/b&n, tamaño, zona del cuerpo, consentimiento de publicación.
- **Flujo:** cerrar venta → crear expediente → subir fotos → aprobar para landing.
- **Tablas a crear:** `service_media` (`service_sale_id`, `type`, `url`, `visibility`, `tattoo_style`, `tattoo_zone`, `tattoo_size`, `consent_granted`, `published_at`).
- **Dependencia:** storage durable (S3/R2/Cloudflare) — no PGlite ni disco local.
- **Prioridad:** alta para Jeff (quiere alimentar la landing).

### Landing Astro
- Proyecto separado que consume fotos aprobadas vía API.
- **Falta:** endpoint público en FinOpenPOS que sirva `service_media WHERE visibility='public' AND consent_granted=true`.
- **Prioridad:** baja (depende de service_media primero).

### Telegram — cierre diario
- **Qué necesita Jeff:** al cerrar caja, disparar reporte al canal de Telegram.
- **Contenido:** total ventas día, desglose efectivo/digital, comisiones estimadas, alertas stock bajo mínimo.
- **Implementación:** webhook en `cash-sessions.close` → `POST https://api.telegram.org/bot<TOKEN>/sendMessage`.
- **Variables de entorno:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- **Prioridad:** media — operación funciona sin él, pero Jeff lo quiere.

### WhatsApp — fotos al cliente
- **Qué necesita Jeff:** al finalizar servicio, enviar fotos al WhatsApp del cliente.
- **Implementación:** Meta Cloud API (solo server-side). Requiere Business Account verificado.
- **Variables de entorno:** `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
- **Prioridad:** baja — es una capa de notificación, no operativa.

### Analítica de inventario (ROI, rotación, días en stock)
- **Qué necesita Jeff:** saber qué mercadería funciona, cuánto capital tiene dormido, cuándo reponer.
- **Datos que ya existen:** `purchase_items.unit_cost`, `inventory_movements`, `order_items.unit_price`.
- **Falta:** queries de rotación (días entre compra y agotamiento), margen real, capital en stock valorizado.
- **Prioridad:** media — datos ya están, falta calcularlos en dashboard.

---

## 📋 Resumen de prioridades

| Gap | Prioridad | Esfuerzo | Bloqueante para |
|-----|-----------|---------|----------------|
| Página admin service_sales | Alta | Bajo | Historial Jeff |
| Reglas comisión Jeron/piercing | Alta | Medio | Liquidaciones |
| Duración tatuaje en service_sales | Media | Bajo | Analítica futura |
| Plantillas gastos recurrentes | Media | Bajo | Reportes fijos |
| service_kits (consumo por servicio) | Media | Medio | COGS real |
| service_media (fotos) | Alta | Alto | Landing, WhatsApp |
| Agenda/appointments | Media | Alto | Estaciones |
| Analítica ROI inventario | Media | Medio | Decisiones Jeff |
| Telegram cierre diario | Media | Bajo | Notificaciones |
| WhatsApp fotos cliente | Baja | Medio | UX post-venta |
| Landing Astro | Baja | Alto | Marketing |

---

## 📁 Contexto histórico

- `cursor_local_amparo_business_overview.md` — conversación completa Cursor que define el negocio Jeff (sedes, comisiones, inventario, flujo POS, fotos, Telegram, WhatsApp, agenda).
- `cursor_finopenpos_migration_and_server.md` — contexto de migración e infraestructura del servidor.
- Plan original (Cursor): `/Users/abautixta/.cursor/plans/dominio_tatuajes_jeff_16e87581.plan.md`
