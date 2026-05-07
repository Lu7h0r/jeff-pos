# Workspace Facts — FinOpenPOS Jeff

## Producción

- **URL pública:** `admin.sanctum.tattoo`
- **VPS:** `devir-server` (SSH host configurado)
- **Path en servidor:** `/var/www/sanctum/web`
- **Compose prod:** `docker-compose.prod.yml`
- **Contenedor web:** `sanctum-web`
- **DNS:** Cloudflare (proxy activado)
- **Runbook completo:** `docs/jeff/DEPLOY.md`

## Comandos prod habituales

```bash
# Conectar al VPS
ssh devir-server

# Ver estado
docker compose -f /var/www/sanctum/web/docker-compose.prod.yml ps

# Rebuild y reiniciar
docker compose -f /var/www/sanctum/web/docker-compose.prod.yml up -d --build

# Ver logs
docker compose -f /var/www/sanctum/web/docker-compose.prod.yml logs -f sanctum-web

# Entrar al contenedor
docker exec -it sanctum-web sh

# Bootstrap owner (desde dentro del contenedor)
bun run bootstrap:prod
```

## Auth / Cookie

- Cookie prefix: `sanctum` → la cookie de sesión se llama `sanctum.session_token` (o variante con punto)
- El proxy en `src/proxy.ts` detecta esta cookie explícitamente — no usar el helper default de Better Auth
- Si el login hace loop, verificar que la detección de cookie en el proxy esté activa

## Variables de Entorno Críticas

```
DATABASE_URL              # Postgres prod connection string
BETTER_AUTH_SECRET        # Secret para JWT/cookies
BETTER_AUTH_URL           # URL base pública (https://admin.sanctum.tattoo)
BOOTSTRAP_OWNER_EMAIL     # Email del owner inicial
BOOTSTRAP_OWNER_PASSWORD  # Password del owner inicial (cambiar tras bootstrap)
```

## Inventario Legado (Treinta / "30")

- Dump en `/Users/abautixta/Dev/Jeff/treinta_inventario.md`
- Script de importación: `scripts/import-treinta-inventory.ts`
- Modo dry-run: `--dry-run`, solo normalizar: `--normalize-only`
- Importado en prod en sesiones anteriores — verificar antes de reimportar

## Workspace Local

- Repo: `/Users/abautixta/Dev/Jeff/oss/FinOpenPOS`
- Workspace padre: `/Users/abautixta/Dev/Jeff/`
- AGENTS.md del workspace: `/Users/abautixta/Dev/Jeff/AGENTS.md`
- Branch de trabajo: `main` (fork; upstream apunta a `vrossini/FinOpenPOS`)
- Referencias: `oss/studio-crm` (MIT), `oss/NexoPOS` (GPLv3)

## PGlite (dev) Quirks

- Solo un proceso escritor a la vez
- Datos en `data/` (local, no commit)
- Si `bun run dev` está corriendo: parar antes de `db:push`, `db:seed:jeff`, `db:migrate`
- Errores de "database is locked" = dos procesos compitiendo

## Postgres (prod)

- Instancia existente en el VPS, base y usuario dedicados
- `DATABASE_URL` en `/var/www/sanctum/web/.env`
- Backup antes de migraciones de schema en prod
