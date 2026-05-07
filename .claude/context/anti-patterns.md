# Anti-Patterns — FinOpenPOS Jeff

## Lo que NO Hacer

### Multi-tenant
- NO hacer queries sin `business_id` en el WHERE — es una fuga de datos entre negocios
- NO confiar en `location_id` del input sin verificar que pertenece al scope del usuario (usar `requireLocationScope`)
- NO asumir que `locationId` siempre viene — puede ser null si el usuario tiene acceso BROAD

### Base de Datos
- NO cambiar `schema.ts` sin generar y aplicar la migración Drizzle correspondiente
- NO borrar tablas o columnas sin verificar FK constraints y tests
- NO usar `db.push` en producción — siempre `db:migrate` con migraciones versionadas
- NO correr seeds/migrations con `bun run dev` activo (PGlite = un escritor simultáneo)
- NO confiar en `products.in_stock` como fuente de verdad — usar `inventory_balances`

### Ventas y Caja
- NO aceptar `total` del cliente en `orders.create` — siempre recalcular desde precios en DB
- NO borrar órdenes — usar `orders.void` con motivo obligatorio
- NO crear movimientos de inventario fuera de la transacción de venta
- NO permitir ventas sin caja abierta (`cash_sessions` activa en el local)

### Auth
- NO usar helpers default de Better Auth para detectar sesión — la cookie tiene prefix `sanctum`
- NO duplicar lógica de auth en componentes — usar el guard centralizado
- NO leer la cookie de sesión en Server Components del layout

### Código
- NO refactorizar código fuera del scope del cambio actual
- NO agregar dependencias sin consultar
- NO hacer commits automáticamente — esperar orden explícita
- NO crear archivos de sesión o planning en la raíz del repo (`REFACTOR-*.md`, etc.)
- NO usar `console.log` para debug en producción — usar logs de Next.js/Bun
- NO hardcodear monedas distintas a COP
- NO usar voseo en UI/copy del producto — español neutro

### Tests
- NO tocar `__tests__/helpers.ts:TABLES` sin entender el orden de FK cleanup
- NO mockear la DB en tests de routers — los tests usan PGlite real
- NO agregar tests que no limpian su estado (usar el helper de cleanup)

## Reglas de Scope

- Bug fix: cambio mínimo, NO refactorizar adyacente
- Feature: solo lo pedido, sin "por las dudas"
- Schema change: siempre con migración + actualizar TABLES en helpers.ts si hay tabla nueva
- Deploy: siempre con backup previo de DB y verificar variables de entorno
