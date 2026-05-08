# AGENTS.md — FinOpenPOS Jeff

Next.js 15 + React 19 + tRPC 11 + Drizzle ORM + Better Auth + Bun. PGlite en dev, Postgres en prod.

## Comandos

```bash
bun run dev                      # dev server
bun run build                    # build prod
bun run lint                     # ESLint
bun run db:push                  # push schema
bun run db:seed:jeff             # seed Amparo + Britalia + user demo
bun run db:generate              # generar migraciones
bun run db:migrate               # aplicar migraciones
bun run inventory:import:treinta # importar inventario Treinta
bun run bootstrap:prod           # bootstrap owner en prod
bun test                         # tests tRPC
bun test --coverage              # con coverage
```

## Archivos Sensibles — leer antes de tocar

- `src/lib/db/schema.ts` — definición completa de tablas; cambio = migración obligatoria
- `src/lib/trpc/routers/orders.ts` — venta atómica, no romper transacción
- `src/lib/trpc/scope-guards.ts` — multi-tenant scope; tocar con cuidado
- `src/lib/trpc/role-guards.ts` — permisos por rol
- `src/lib/trpc/active-context.ts` — resolución business+location
- `src/lib/trpc/routers/__tests__/helpers.ts` — TABLES registry; afecta TODOS los tests
- `src/proxy.ts` — detección cookie `sanctum`; cambiar = loop de login en prod

## Restricciones Críticas

- **PGlite:** solo un proceso escritor a la vez — parar `bun run dev` antes de seeds/migrations
- **Sin cambios de schema** sin migración Drizzle (`db:generate` + `db:migrate`)
- **Sin agregar dependencias** sin consultar
- **Sin refactors** fuera del scope del cambio actual
- **Sin commits automáticos** — esperar orden explícita
- **Scope multi-tenant:** toda operación lleva `business_id` + opcionalmente `location_id`
- **Moneda:** COP siempre; no hardcodear símbolos de otras monedas
- **Auth cookie prefix:** `sanctum` (no el default de Better Auth)
- **UI/copy:** español neutro, no rioplatense

## Módulo Agendamientos (obligatorio)

- **Multi-nicho + multi-sede:** agendamientos funcionan para tattoo/piercing/otros y siempre en contexto `business_id` + `location_id`.
- **Create booking:** requiere `staffId` válido del business activo; no permitir unassigned por default.
- **Staff por sede:** si existe relación de `location_members` para el usuario asociado al staff, exigir membresía `active` en la sede seleccionada.
- **No solape:** bloquear cruces de horario por `staff_id + location_id` en create/reschedule (incluye respuestas externas con reschedule).
- **Completed:** mantener regla `service_agreement_id` obligatorio antes de pasar a `completed`.
- **Summary:** siempre filtrar por rango y opcionalmente por `locationId`/`staffId`.
- **n8n booking events:** publicar en outbox `booking_created|booking_confirmed|booking_rescheduled|booking_cancelled` con `idempotency_key` estable (`<event_type>:booking:<booking_id>`).

## Antes de Commitear

```bash
bun run lint && bun test
```

## Contexto (Engram — cross-tool)

`mem_search "jeff-pos"` para decisiones y convenciones previas. Módulos de contexto en `.claude/context/`. Intent map en `.claude/jeff-intent-map.json`.

## Documentación

```
docs/jeff/PLAN.md       # plan vivo con batches
docs/jeff/DEUDA.md      # bugs rastreados (DA-1..DA-N)
docs/jeff/DEPLOY.md     # runbook de producción
docs/jeff/REFERENCIAS.md
```
