#!/bin/sh
set -eu

# psql variable substitution quotes passwords as literals; no URL interpolation
# or shell evaluation. This runs only for a NEW PostgreSQL data volume.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=owner_password="$POSTGRES_OWNER_PASSWORD" \
  --set=app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
CREATE ROLE hatcheck_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'owner_password';
CREATE ROLE hatcheck_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER DATABASE hatcheck OWNER TO hatcheck_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO hatcheck_owner;
GRANT CONNECT ON DATABASE hatcheck TO hatcheck_owner, hatcheck_app;
GRANT USAGE ON SCHEMA public TO hatcheck_app;
SQL
