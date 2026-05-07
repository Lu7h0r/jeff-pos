# Domain Concepts — FinOpenPOS Jeff

## Negocio y Sedes

**Jeff** — tattoo studio con 2 sedes activas:

| Sede | Estaciones | Horario | Arriendo | Otros costos fijos |
|------|-----------|---------|----------|-------------------|
| Amparo | 2 | L-D 11:00–21:00 | 1.430.000 | luz 230k, internet 25k, bio 25k, agua 60k/bimestral |
| Britalia | Estaciones Jeff | — | 1.700.000 | luz 220k, gas 25k, internet 80k, agua 130k/bimestral |

**Modelo de socios:** Jeff (dueño) + Jeron (capitalista). Tatuajes de empleadas: 70% → Jeff+Jeron 50/50 cada uno, 30% → empleada + sueldo base. Tatuajes hechos por Jeff: 100% para Jeff.

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

**Perforaciones:** desde la 5ª del día = 3.000 COP por perforación.

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

Guest artists pueden alquilar estaciones con su propio split de ingresos. Configurado en `workstations` + `station_rentals`.
