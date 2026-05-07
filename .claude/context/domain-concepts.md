# Domain Concepts — FinOpenPOS Jeff

## Negocio y Sedes

**Jeff** — tattoo studio con 2 sedes activas:

| Sede | Estaciones | Horario | Arriendo | Otros costos fijos |
|------|-----------|---------|----------|-------------------|
| Amparo | 2 | L-D 11:00–21:00 | 1.430.000 | luz 230k, internet 25k, bio 25k, agua 60k/bimestral |
| Britalia | Estaciones Jeff | L-D (horario a confirmar) | 1.700.000 | luz 220k, gas 25k, internet 80k, agua 130k/bimestral |

**Total costos fijos aprox:** ~3.830.000 COP/mes entre las dos sedes (sin sueldos).

**Modelo de socios:** Jeff (dueño) + Jeron (socio capitalista).

| Escenario | Reparto |
|-----------|---------|
| Tatuaje por empleada/colaboradora | 30% → tatuador/a; 70% → "casa" → Jeff+Jeron 50/50 |
| Tatuaje por Jeff | 100% para Jeff (no aplica el 70-30) |
| Inventario/mercancía Amparo | Costos e ingresos 50/50 Jeff+Jeron |
| Inventario/mercancía Britalia | 100% Jeff (Jeron no tiene participación aquí) |

**⚠️ Definición abierta:** "ganancia" para Jeron = ¿bruto del 70%? ¿o neto tras insumos variables? No está cerrado en código. Las comisiones son estimadas/manuales.

## Multi-Tenant — Regla de Oro

Toda entidad operativa lleva `business_id`. Entidades de sede llevan además `location_id`.

```typescript
// Contexto activo resuelto en active-context.ts
interface ActiveContext {
  businessId: number;
  locationId: number | null;
  role: string;
  isLocationScoped: boolean;
  effectiveLocationIds: number[];
}
```

**Cookie `jeff_active_location`:** define la sede activa en la UI. El servidor la lee via `locationIdHint` en `resolveActiveContext()`.

**Acceso BROAD** (business_members): owner/manager/cashier/artist con acceso a todos los locales del negocio.
**Acceso GRANULAR** (location_members): solo opera en las sedes específicamente asignadas.
BROAD gana si ambas filas existen para el mismo usuario.

## Servicios y Productos

Servicios cubiertos: tatuajes, perforaciones, joyería y merch (smoking, grinders, vapeadores, papeletas, ropa, sex shop).

**Perforaciones:** desde la 5ª del día = 3.000 COP por perforación (comisión al tatuador/a). Las primeras 4 del día no comisionan para el staff. **Esta regla no está automatizada en código — es manual.**

**Productos con métricas de rentabilidad:**
- `cost_price` — costo de adquisición
- `selling_price` — precio de venta
- ganancia unitaria = `selling_price - cost_price`
- margen = `(ganancia / selling_price) * 100`
- `image_url` — URL principal de foto
- `image_urls` — JSON array de URLs adicionales

## Caja por Turno (cash_sessions)

- Una caja por turno por local. No se puede vender sin caja abierta.
- Apertura requiere `opening_balance` (monto inicial en efectivo).
- Cierre genera arqueo: efectivo esperado vs. real.
- `cash_movements` registra cada movimiento dentro del turno.
- Tipos de movimiento: `sale`, `refund`, `expense`, `adjustment`, `opening`, `closing`.

## Inventario por Sede

- `inventory_balances`: stock actual por `(product_id, location_id)`.
- `inventory_movements`: historial de movimientos (entrada/salida).
- Tipos: `purchase`, `sale`, `adjustment`, `transfer`, `return`.
- Venta descuenta stock atómicamente: `UPDATE ... WHERE quantity_on_hand >= qty RETURNING *` — si RETURNING vacío → CONFLICT.

## Venta Atómica (orders.create — CRÍTICO)

El flujo completo ocurre en una sola transacción DB:
1. Calcular total desde precios en DB (ignorar total del cliente)
2. Validar `sum(paymentLines.amount) === computed_total`
3. Descontar `inventory_balances` con guarda atómica
4. Crear `order` + `order_items` + `order_payments`
5. Crear `inventory_movements` type=`sale`
6. Crear `cash_movements` en la caja activa

**Anulación:** `orders.void` — nunca borrar una orden; marcar `process_status=void`, revertir stock y caja.

## Roles

| Rol | Permisos |
|-----|----------|
| `owner` | Todo |
| `manager` | Todo excepto gestión de negocio |
| `cashier` | Ventas, caja, inventario lectura |
| `artist` | Ventas propias, perfil |

## Moneda

Siempre COP. Formatear con `formatCOP()` en UI. Sin hardcodear `$` o `USD`.

## Comisiones (commission_estimates)

Sistema de estimación de comisiones para staff. Las reglas abiertas no se automatizan — se guardan como estimaciones para revisión manual. `commission_split.ts` tiene los cálculos.

## Alquiler de Estaciones (station_rentals)

Guest artists pueden alquilar estaciones con su propio split de ingresos. Configurado en `workstations` + `station_rentals`. **El ingreso por alquiler entra en la caja diaria del local donde está la estación** — no es ingreso separado.

## Fotos de Servicio (PENDIENTE — sin tabla en schema)

Jeff quiere: al cerrar venta de servicio → subir fotos → organizar → publicar en landing.

**Flujo:** cerrar venta → crear expediente de servicio → subir fotos (puede ser después del cierre de caja, no necesariamente en el momento) → aprobar visibilidad → landing Astro consume solo las aprobadas.

**Taxonomía de tatuajes** (para categorizar fotos): estilo (realismo, blackwork, fine line, lettering, cover up, neotradicional), color/b&n, tamaño, zona del cuerpo, consentimiento del cliente para publicar.

**Regla:** se puede editar expediente/fotos después del cierre. No se puede editar la venta/costos salvo corrección con permiso `owner`.

**Tabla necesaria (no existe aún):** `service_media` con campos `service_sale_id`, `type` (referencia/stencil/proceso/resultado), `url`, `visibility` (interna/compartible/pública), taxonomía de tatuaje, `consent_granted`.

**Storage:** las fotos NO pueden vivir en PGlite/disco local en producción. Necesitan S3/R2/Cloudflare R2 o similar.

## Agenda (PENDIENTE — sin tabla en schema)

Jeff necesita agenda interna por local, estación, tatuador y cliente. No portal público todavía. Sirve para saber qué estación está ocupada y cuándo.

**Tabla necesaria (no existe aún):** `appointments` con `business_id`, `location_id`, `workstation_id`, `staff_member_id`, `customer_id`, `start_at`, `end_at`, `status`, `service_kind`.

## Duración del Servicio (PENDIENTE — campo faltante)

`service_sales` no tiene `duration_minutes`. Jeff quiere registrar cuánto tardó el tatuaje (opcional) para analítica de productividad y estrategia de precios. Campo a agregar en próxima migración.

## Notificaciones (PENDIENTE — sin integración)

- **Telegram:** al cerrar caja → reporte diario al canal (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Contenido: ventas, efectivo/digital, comisiones estimadas, alertas stock bajo.
- **WhatsApp:** fotos al cliente al finalizar servicio (Meta Cloud API, solo server-side). Requiere Business Account.

## Analítica de Inventario (PENDIENTE — datos existen, faltan queries)

Jeff quiere: cuánto invirtió, cuánto tiempo lleva quieto, margen, rotación por sede, capital dormido. Los datos ya existen (`purchase_items.unit_cost`, `inventory_movements`, `order_items.unit_price`) pero faltan las queries/vistas en dashboard.
