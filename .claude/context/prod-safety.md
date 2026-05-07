# Prod Safety — FinOpenPOS Jeff

## Checklist Antes de Tocar Producción

- [ ] ¿Hay backup de la DB de Postgres? (`pg_dump` o snapshot)
- [ ] ¿El `.env` en `/var/www/sanctum/web/.env` tiene todas las variables críticas?
- [ ] ¿La migración fue testeada localmente primero?
- [ ] ¿El build pasa localmente (`bun run build`)?
- [ ] ¿Los tests pasan (`bun test`)?

## Deploy Seguro

```bash
# 1. En local: verificar todo
bun run lint && bun test && bun run build

# 2. Push al repo
git push origin main

# 3. En el VPS: pull y rebuild
ssh devir-server
cd /var/www/sanctum/web
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build

# 4. Verificar estado
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f sanctum-web
```

## Si el contenedor no levanta

```bash
# Ver logs del error
docker compose -f docker-compose.prod.yml logs sanctum-web

# Verificar .env (sin mostrar en logs)
docker exec sanctum-web printenv | grep -E "DATABASE_URL|BETTER_AUTH" | wc -l

# Restaurar .env desde backup
cp .env.bak .env
docker compose -f docker-compose.prod.yml up -d --build
```

## Si el login hace loop

1. Verificar que `src/proxy.ts` detecta cookie con prefix `sanctum`
2. Verificar `BETTER_AUTH_URL` apunta al dominio correcto
3. Verificar `BETTER_AUTH_SECRET` no cambió entre deploys
4. Usar DevTools → Application → Cookies para confirmar que la cookie existe tras el login

## Si hay 502 de Cloudflare

1. El contenedor `sanctum-web` está caído o crash-looping
2. Ver logs: `docker compose logs sanctum-web`
3. Causa más común: `DATABASE_URL` inválido o faltante en `.env`
4. Restaurar `.env` desde `.env.bak` y rebuild

## Reset de Password Owner (emergencia)

Desde dentro del contenedor:

```bash
docker exec -it sanctum-web sh
# Dentro del contenedor:
bun run bootstrap:prod
```

O directamente via script que usa `better-auth/crypto.hashPassword` y actualiza tabla `account` (provider `credential`).

## Restricciones de Producción

- NO hacer `db:push` en prod — solo `db:migrate` con migraciones versionadas
- NO correr seeds en prod (excepto bootstrap inicial)
- NO forzar rebuild sin backup de DB si hay migraciones pendientes
- NO cambiar `BETTER_AUTH_SECRET` sin invalidar todas las sesiones activas
