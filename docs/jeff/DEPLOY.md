# Deploy Jeff POS en `devir-server` (prod)

Guia corta, operativa y copy-pasteable para levantar FinOpenPOS adaptado para Jeff en produccion.

## 1) Prerequisitos VPS

- Ubuntu/Debian con acceso SSH (usuario con permisos Docker).
- Docker + Docker Compose plugin.
- Git.
- Nginx en host (reverse proxy) + TLS (certbot o Cloudflare Origin Cert).
- DNS del dominio apuntando al VPS.

Verificacion rapida:

```bash
docker --version
docker compose version
nginx -v
git --version
```

## 2) Clonado y remotos

```bash
mkdir -p /var/www/sanctum
cd /var/www/sanctum
git clone git@github.com:abautixta/jeff-pos.git web
cd web
git checkout jeff-main

# opcional pero recomendado: registrar upstream
git remote add upstream git@github.com:JoaoHenriqueBarbosa/FinOpenPOS.git
git fetch --all --prune
```

## 3) Variables de entorno criticas

Crear `.env` en `/var/www/sanctum/web/.env` (no commitear):

```bash
cp .env.example .env
```

Completar como minimo:

- `DATABASE_URL` (debe apuntar al servicio `postgres` de `docker-compose.prod.yml`).
- `BETTER_AUTH_SECRET` (>= 32 chars aleatorios).
- `BETTER_AUTH_URL` (URL publica exacta, por ejemplo `https://admin.sanctum.tattoo`).
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`.
- `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD`.
- `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_OWNER_PASSWORD`, `BOOTSTRAP_OWNER_NAME`.
- `BOOTSTRAP_BUSINESS_NAME`, `BOOTSTRAP_BUSINESS_SLUG`, `BOOTSTRAP_LOCATIONS`.

Generar secretos:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 24   # passwords postgres/app
```

## 4) Build + run (prod)

Desde `/var/www/sanctum/web`:

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail 100 web
```

Notas:
- `web` queda publicado en `127.0.0.1:3201`.
- `postgres` usa volumen `sanctum_postgres_data`.

## 5) Migraciones + bootstrap

Ejecutar una vez al aprovisionar y luego en cada release que traiga migrations:

```bash
docker compose -f docker-compose.prod.yml exec web bun run db:migrate
docker compose -f docker-compose.prod.yml exec web bun run bootstrap:prod
```

Ambos scripts son idempotentes y usan variables de `.env`.

## 6) Import inventario Treinta en prod

### Opcion A: normalizar primero (recomendado)

```bash
docker compose -f docker-compose.prod.yml exec web \
  bun run inventory:import:treinta --normalize-only
```

### Opcion B: import real a DB

```bash
docker compose -f docker-compose.prod.yml exec web \
  bun run inventory:import:treinta
```

Opcionales por entorno:

```bash
TREINTA_MD_PATH=/ruta/al/archivo.md
TREINTA_BUSINESS_SLUG=jeff
TREINTA_LOCATION_SLUG=amparo
```

Si queres validar sin escribir en DB:

```bash
docker compose -f docker-compose.prod.yml exec web \
  bun run inventory:import:treinta --dry-run
```

## 7) Nginx + Cloudflare checks

### Nginx host

El upstream debe apuntar a `127.0.0.1:3201` y pasar headers:

```nginx
location / {
    proxy_pass http://127.0.0.1:3201;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Checks:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -I https://admin.sanctum.tattoo/login
```

### Cloudflare

- SSL/TLS mode: `Full (strict)`.
- DNS record del subdominio apuntando al VPS correcto.
- Si hay cache agresiva, excluir `/api/*` y `/login`.

Check rapido:

```bash
curl -I https://admin.sanctum.tattoo
```

## 8) Troubleshooting corto

### 502 Bad Gateway

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail 200 web
docker compose -f docker-compose.prod.yml logs --tail 200 postgres
```

Validar que `web` este `Up` y que Nginx siga apuntando a `127.0.0.1:3201`.

### Loop de login

- Revisar `BETTER_AUTH_URL` (tiene que ser la URL publica exacta con `https`).
- Revisar headers `Host` y `X-Forwarded-Proto` en Nginx.
- Limpiar cookies del dominio y reintentar.

### Error de credenciales / bootstrap

```bash
docker compose -f docker-compose.prod.yml exec web bun run bootstrap:prod
```

Si falla, verificar envs `BOOTSTRAP_OWNER_*` y que `DATABASE_URL` conecte al `postgres` del compose.

## 9) Comandos utiles de operacion

```bash
# actualizar codigo en servidor
cd /var/www/sanctum/web
git fetch origin
git checkout jeff-main
git pull origin jeff-main

# redeploy
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec web bun run db:migrate

# logs
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f postgres
```
