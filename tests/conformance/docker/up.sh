#!/bin/sh
# Usage: up.sh <project-name>   -> starts the stack, prints REFERENCE_URL / NODEFGA_URL / PG_PORT as shell exports.
set -e
cd "$(dirname "$0")"
P="${1:?project name}"
: "${CONF_PG_PASSWORD:=$(openssl rand -hex 12)}"
export CONF_PG_PASSWORD
docker compose --env-file /dev/null -p "$P" up -d --build >&2
port() { docker compose --env-file /dev/null -p "$P" port "$1" "$2" | sed 's/.*://'; }
R=$(port reference 8080); N=$(port nodefga 8080); G=$(port postgres 5432)
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$R/healthz" >/dev/null && curl -sf "http://127.0.0.1:$N/ready" >/dev/null && break
  sleep 1
done
echo "export REFERENCE_URL=http://127.0.0.1:$R NODEFGA_URL=http://127.0.0.1:$N PG_PORT=$G CONF_PG_PASSWORD=$CONF_PG_PASSWORD COMPOSE_PROJECT=$P"
