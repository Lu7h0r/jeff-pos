# Deploy a producción — Sanctum Tattoo POS

Runbook canónico para llevar y mantener `admin.sanctum.tattoo` en el VPS
`devir-server`. Sigue el mismo patrón que `upi.abautixta.com`: Postgres en
container dedicado + app Next.js en container + nginx host como reverse proxy
+ certbot para TLS.

---

## 0 · Topología

```
[Internet :443]
       │
       ▼
[nginx host]                                /etc/nginx/sites-enabled/sanctum
       │  proxy_pass http://127.0.0.1:3201
       ▼
┌──────────────── docker network: sanctum_private_net ────────────────┐
│                                                                       │
│   sanctum-web (Next.js, port 3000)                                    │
│        │                                                              │
│        └── postgres://sanctum_app:***@postgres:5432/sanctum           │
│                                                                       │
│   sanctum-postgres (postgres:16-alpine, vol sanctum_postgres_data)    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

Workdir en VPS: `/var/www/sanctum/web/` (clon del repo).

---

## 1 · Pre-requisitos en GitHub (una sola vez)

1. **Crear el repo privado** `abautixta/sanctum-pos` (o el nombre que elijas).
   ```bash
   # En tu máquina, dentro de oss/FinOpenPOS
   git remote add origin git@github.com:abautixta/sanctum-pos.git
   git push -u origin jeff-main
   git push origin --tags
   ```

2. **Generar SSH keypair dedicado para CI** (no reuses tu key personal):
   ```bash
   ssh-keygen -t ed25519 -C "github-actions@sanctum" -f ~/.ssh/sanctum_deploy -N ""
   cat ~/.ssh/sanctum_deploy.pub  # copiá el contenido
   ```
   Luego en el VPS:
   ```bash
   ssh devir-server 'echo "<pub key>" >> ~/.ssh/authorized_keys'
   ```

3. **Configurar secrets del repo** (Settings → Secrets and variables → Actions):
   - `SSH_PRIVATE_KEY` — contenido de `~/.ssh/sanctum_deploy` (privada).
   - `SSH_HOST` — `147.93.184.180`.
   - `SSH_USER` — `root`.
   - `DEPLOY_PATH` — `/var/www/sanctum/web`.
   - `PROD_URL` — `https://admin.sanctum.tattoo`.

---

## 2 · DNS (una sola vez)

En el panel del registrador del dominio `sanctum.tattoo`, agregar:

```
Tipo   Nombre   Valor               TTL
A      admin    147.93.184.180      3600
```

Verificar:
```bash
dig +short admin.sanctum.tattoo   # debe devolver 147.93.184.180
```

---

## 3 · Provisioning del VPS (una sola vez)

```bash
ssh devir-server
mkdir -p /var/www/sanctum
cd /var/www/sanctum

# Clonar el repo (Deploy Key sólo de lectura es suficiente)
git clone git@github.com:abautixta/sanctum-pos.git web
cd web
git checkout jeff-main
```

### 3.1 · Crear `.env` (NO commitear)

```bash
cp .env.example .env
nano .env
```

Variables que **debés** cambiar:
- `POSTGRES_PASSWORD` — `openssl rand -base64 24`
- `POSTGRES_APP_PASSWORD` — `openssl rand -base64 24`
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`
- `BOOTSTRAP_OWNER_PASSWORD` — la contraseña real de Jeff (≥8 chars)
- `DATABASE_URL` — actualizar la password del app user para que coincida con
  `POSTGRES_APP_PASSWORD`.

### 3.2 · Levantar containers

```bash
cd /var/www/sanctum/web
docker compose -f docker-compose.prod.yml up -d --build

# Esperar a que Postgres pase a healthy
docker compose -f docker-compose.prod.yml ps

# Aplicar migraciones (la primera vez crea todas las tablas)
docker compose -f docker-compose.prod.yml exec web bun scripts/migrate.ts

# Bootstrap del owner real + Sanctum + locales (idempotente)
docker compose -f docker-compose.prod.yml exec web bun scripts/bootstrap-prod.ts
```

### 3.3 · Vhost de nginx

```bash
sudo nano /etc/nginx/sites-available/sanctum
```

Contenido (copiar tal cual, ajustá sólo el `server_name` si cambiás dominio):

```nginx
server {
    listen 80;
    server_name admin.sanctum.tattoo;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name admin.sanctum.tattoo;

    ssl_certificate /etc/letsencrypt/live/admin.sanctum.tattoo/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.sanctum.tattoo/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    access_log /var/log/nginx/sanctum.access.log;
    error_log /var/log/nginx/sanctum.error.log;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3201;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout                 120s;
        proxy_send_timeout                 120s;
    }
}
```

Activar y emitir certificado:

```bash
sudo ln -s /etc/nginx/sites-available/sanctum /etc/nginx/sites-enabled/sanctum
sudo nginx -t              # validar sintaxis
sudo certbot --nginx -d admin.sanctum.tattoo --redirect --non-interactive --agree-tos -m TU_EMAIL@dominio
sudo systemctl reload nginx
```

### 3.4 · Smoke test

```bash
curl -I https://admin.sanctum.tattoo/login
# Esperado: HTTP/2 200
```

Loguearse en navegador con las credenciales del bootstrap.

---

## 4 · Deploys posteriores (automáticos)

Cualquier push a `jeff-main` dispara `.github/workflows/deploy.yml`:

```
push jeff-main
   → GitHub Actions clona, hace ssh devir-server
   → git fetch + reset --hard origin/jeff-main en /var/www/sanctum/web
   → docker compose up -d --build
   → migra el contenedor web (drizzle migrate)
   → smoke test contra https://admin.sanctum.tattoo/login
```

Para deployar manualmente: pestaña Actions → workflow Deploy → Run workflow.

---

## 5 · Rollback

Si un deploy rompe prod:

```bash
ssh devir-server
cd /var/www/sanctum/web

# Volver al commit anterior
git log --oneline -10                          # buscar el SHA estable
git reset --hard <SHA-ANTERIOR>

# Re-build con el código anterior
docker compose -f docker-compose.prod.yml up -d --build

# Si la migración del deploy roto dejó la DB en un estado nuevo, restaurar
# desde backup más reciente (sección 7).
```

⚠️ Drizzle migrations no tienen `down`. Si necesitás revertir una migración de
schema, restaurá la DB del backup y re-aplicá las migraciones que sí querías.

---

## 6 · Logs y diagnóstico

```bash
ssh devir-server
cd /var/www/sanctum/web

# Logs en vivo (último minuto)
docker compose -f docker-compose.prod.yml logs --tail 200 -f web
docker compose -f docker-compose.prod.yml logs --tail 200 -f postgres

# Estado de los containers
docker compose -f docker-compose.prod.yml ps

# Restart sólo la app (sin tocar DB)
docker compose -f docker-compose.prod.yml restart web

# Entrar al container web
docker compose -f docker-compose.prod.yml exec web sh

# Conectarse a la DB (con superuser)
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Logs de nginx:
```bash
tail -f /var/log/nginx/sanctum.access.log /var/log/nginx/sanctum.error.log
```

---

## 7 · Backups

Los backups del volumen `sanctum_postgres_data` son **responsabilidad del
operador**. Crear un cron diario en el VPS:

```bash
sudo nano /etc/cron.d/sanctum-backup
```

```cron
# Daily pg_dump at 03:00 -03 (Bogotá)
0 8 * * * root /var/www/sanctum/web/scripts/backup.sh >> /var/log/sanctum-backup.log 2>&1
```

Crear `/var/www/sanctum/web/scripts/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /var/www/sanctum/web
TS=$(date +%Y%m%d_%H%M%S)
mkdir -p backups
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  > "backups/sanctum_${TS}.dump"
# Retain last 14 days
find backups -name "sanctum_*.dump" -mtime +14 -delete
```

Restore:
```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  < backups/sanctum_<timestamp>.dump
```

---

## 8 · Recursos esperados

| Recurso         | Esperado                |
| --------------- | ----------------------- |
| RAM en idle     | ~250 MB (postgres + web) |
| CPU en idle     | < 1 %                   |
| Disco / mes     | ~50 MB DB + logs        |
| Tiempo de boot  | ~30 s para `up -d --build` |
| Tiempo de migrate | ~2 s en DB pequeña    |

Tope superior estimado para 2 locales (Amparo + Britalia) en operación normal:
~600 MB RAM, ~2 GB DB en 6 meses. Margen amplio en el VPS actual (5 GB libres).

---

## 9 · Próximos pasos no críticos

- DA-6: agregar `UNIQUE (location_id, product_id)` a `inventory_balances`
  (requiere Postgres real → ya lo tenemos en prod, se puede cerrar).
- DA-22: agregar CHECK constraint en `business_members` y `location_members`
  para forzar exclusividad broad/granular a nivel DB.
- Storage durable para fotos de servicios (Capa 9): MinIO en otro container o
  mount de un bucket externo.
