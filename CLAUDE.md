# CLAUDE.md — FinOpenPOS Jeff

Sistema POS multi-sede para Jeff: tattoo studio con 2 locales (Amparo y Britalia), caja por turno, inventario por sede, ventas atómicas, staff y servicios. Fork de FinOpenPOS (upstream: `vrossini/FinOpenPOS`).

## Stack

Bun · Next.js 15 · React 19 · tRPC 11 · Drizzle ORM · Better Auth · PGlite (dev) · Postgres (prod) · shadcn/ui · Tailwind CSS

## Comandos

```bash
bun run dev                     # dev server (para DB, push schema y seed Jeff)
bun run build                   # build producción
bun run lint                    # ESLint
bun run db:push                 # push schema a PGlite/Postgres
bun run db:seed:jeff            # seed datos Jeff (Amparo + Britalia + user demo)
bun run db:generate             # generar migraciones Drizzle
bun run db:migrate              # aplicar migraciones
bun run inventory:import:treinta  # importar inventario desde treinta_inventario.md
bun run bootstrap:prod          # bootstrap owner en producción
bun test                        # tests tRPC (src/lib/trpc/routers/__tests__)
bun test --coverage             # con coverage
```

**IMPORTANTE:** PGlite no soporta dos procesos escribiendo simultáneamente. Parar `bun run dev` antes de correr seeds/migrations.

## Archivos Críticos — leer antes de tocar

- `src/lib/db/schema.ts` — todas las tablas; cambiar = migración obligatoria
- `src/lib/trpc/routers/orders.ts` — venta atómica (transacción DB completa)
- `src/lib/trpc/scope-guards.ts` — guards de scope multi-tenant
- `src/lib/trpc/role-guards.ts` — guards de rol (owner/manager/cashier/artist)
- `src/lib/trpc/active-context.ts` — resolución business+location por usuario
- `src/lib/trpc/routers/__tests__/helpers.ts` — registry central de tablas para tests
- `src/proxy.ts` — proxy con detección de cookie `sanctum` (cookie prefix de Better Auth)

## Estructura de Routers tRPC

```
businesses · locations · location-members · team
products · inventory · purchases · suppliers
orders · cash-sessions · expenses · payment-methods
staff · workstations · station-rentals · services
customers · dashboard
```

## Convenciones

- **Scoping:** toda mutación operativa requiere `business_id` + `location_id`; nunca operar sin contexto activo
- **Moneda:** COP (pesos colombianos); formatear en UI con `formatCOP()`
- **Commits:** Conventional Commits en inglés (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`)
- **Auth:** Better Auth con cookie prefix `sanctum`; guard en `src/lib/auth-guard.ts`
- **Tests:** Bun test; helpers en `__tests__/helpers.ts`; un test file por router
- **Sin comentarios innecesarios** — nombres autodescriptivos; comentar solo invariantes no obvios
- **UI/copy del producto:** español neutro (no rioplatense)

## Contexto Extendido (lazy-load via hook)

El hook `.claude/hooks/jeff-promptsubmit.py` inyecta módulos según el intent del prompt.

| Intent | Módulos |
|--------|---------|
| `fix` / `bug` | domain-concepts + anti-patterns |
| `schema` / `db` | architecture + backend-patterns |
| `sale` / `order` / `caja` | domain-concepts + backend-patterns |
| `inventory` | domain-concepts + backend-patterns |
| `frontend` / `ui` | frontend-patterns + anti-patterns |
| `deploy` / `prod` | workspace-facts + prod-safety |
| `staff` / `commission` | domain-concepts |
| `test` | backend-patterns |
| `architecture` | architecture + backend-patterns |

Módulos en `.claude/context/`. Intent map en `.claude/jeff-intent-map.json`.

## Plan y Deuda

- Plan vivo: `docs/jeff/PLAN.md`
- Deuda activa: `docs/jeff/DEUDA.md`
- Deploy runbook: `docs/jeff/DEPLOY.md`
- Referencias: `docs/jeff/REFERENCIAS.md`

## Variables de Entorno

Ver `.env.example`. Críticas: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_OWNER_PASSWORD`
