#!/usr/bin/env bash
# Runs once at first container boot via /docker-entrypoint-initdb.d.
# Creates a least-privileged app role used by DATABASE_URL at runtime.
# The superuser POSTGRES_USER stays reserved for migrations, backups
# and any future schema changes that need elevated rights.
#
# Required env vars (passed via env_file: .env):
#   POSTGRES_DB              — already created by the postgres image
#   POSTGRES_APP_USER        — non-privileged app role
#   POSTGRES_APP_PASSWORD    — password for the app role

set -euo pipefail

if [[ -z "${POSTGRES_APP_USER:-}" || -z "${POSTGRES_APP_PASSWORD:-}" ]]; then
  echo "POSTGRES_APP_USER and POSTGRES_APP_PASSWORD must be set." >&2
  exit 1
fi

# psql expands :'var' to a quoted literal and :"var" to a quoted identifier.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v app_user="$POSTGRES_APP_USER" \
  -v app_password="$POSTGRES_APP_PASSWORD" \
  -v db_name="$POSTGRES_DB" <<'EOSQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
GRANT CREATE ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
GRANT CREATE ON SCHEMA public TO :"app_user";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO :"app_user";
EOSQL

echo "App role $POSTGRES_APP_USER provisioned."
