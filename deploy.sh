#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-clawmail}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
TEMPLATE_PATH="$SCRIPT_DIR/deploy/Caddyfile.template"
CADDYFILE_PATH="${CADDYFILE_PATH:-/etc/caddy/Caddyfile}"
CONFIGURE_CADDY="${CONFIGURE_CADDY:-true}"
USE_LOCAL_POSTGRES="${USE_LOCAL_POSTGRES:-true}"
MODE="${1:-deploy}"
CHECK_ERRORS=0
CHECK_WARNINGS=0

log() {
  echo "[deploy] $*"
}

usage() {
  cat <<EOF
Usage:
  ./deploy.sh setup   First-time setup: validate env, configure Caddy, set up SMTP cert paths, deploy app
  ./deploy.sh check   Validate .env and print issues without changing the system
  ./deploy.sh         Deploy app and refresh Caddy config
  ./deploy.sh deploy  Same as the default command
EOF
}

is_enabled() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing required file: $path" >&2
    exit 1
  fi
}

check_ok() {
  echo "[check][ok] $*"
}

check_warn() {
  CHECK_WARNINGS=$((CHECK_WARNINGS + 1))
  echo "[check][warn] $*"
}

check_error() {
  CHECK_ERRORS=$((CHECK_ERRORS + 1))
  echo "[check][error] $*"
}

is_valid_port() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 ))
}

is_valid_ipv4() {
  local ip="${1:-}"
  local octet

  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1

  IFS='.' read -r -a octets <<< "$ip"
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]+$ ]] || return 1
    (( octet >= 0 && octet <= 255 )) || return 1
  done
}

is_public_ipv4() {
  local ip="${1:-}"
  local a b

  is_valid_ipv4 "$ip" || return 1

  IFS='.' read -r a b _ <<< "$ip"

  (( a != 0 )) || return 1
  (( a != 10 )) || return 1
  (( a != 127 )) || return 1
  (( !(a == 100 && b >= 64 && b <= 127) )) || return 1
  (( !(a == 169 && b == 254) )) || return 1
  (( !(a == 172 && b >= 16 && b <= 31) )) || return 1
  (( !(a == 192 && b == 168) )) || return 1
  (( !(a == 198 && (b == 18 || b == 19)) )) || return 1

  return 0
}

ensure_directory() {
  local dir="$1"
  mkdir -p "$dir"
}

install_file() {
  local src="$1"
  local dest="$2"

  if [[ -w "$(dirname "$dest")" ]] || [[ ! -e "$dest" && -w "$(dirname "$dest")" ]]; then
    install -m 0644 "$src" "$dest"
  else
    sudo install -d "$(dirname "$dest")"
    sudo install -m 0644 "$src" "$dest"
  fi
}

install_copied_file() {
  local src="$1"
  local dest="$2"
  local mode="$3"

  ensure_directory "$(dirname "$dest")"

  if [[ -r "$src" ]]; then
    install -m "$mode" "$src" "$dest"
  else
    sudo install -d "$(dirname "$dest")"
    sudo install -m "$mode" "$src" "$dest"
    sudo chown "$(id -u):$(id -g)" "$dest"
  fi
}

reload_caddy() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl cat caddy >/dev/null 2>&1; then
      sudo systemctl reload caddy || sudo systemctl restart caddy
      return
    fi
  fi

  log "Caddy config installed at $CADDYFILE_PATH. Reload Caddy using your platform's service manager."
}

load_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    log "Loading environment from $ENV_FILE"
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  else
    log "No .env file found at $ENV_FILE, using current environment"
  fi
}

derive_env_from_app_domain() {
  local app_domain="${APP_DOMAIN:-}"

  if [[ -z "$app_domain" ]]; then
    return 0
  fi

  if [[ -z "${SMTP_BANNER_HOSTNAME:-}" ]]; then
    SMTP_BANNER_HOSTNAME="mx.${app_domain}"
    export SMTP_BANNER_HOSTNAME
  fi

  if [[ -z "${CADDY_ADMIN_EMAIL:-}" ]]; then
    CADDY_ADMIN_EMAIL="admin@${app_domain}"
    export CADDY_ADMIN_EMAIL
  fi

  if [[ -z "${APP_WWW_DOMAIN:-}" ]]; then
    APP_WWW_DOMAIN="www.${app_domain}"
    export APP_WWW_DOMAIN
  fi
}

upsert_env() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"

  if [[ -f "$ENV_FILE" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { updated = 0 }
      index($0, key "=") == 1 {
        print key "=" value
        updated = 1
        next
      }
      { print }
      END {
        if (!updated) {
          print key "=" value
        }
      }
    ' "$ENV_FILE" > "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp"
  fi

  mv "$tmp" "$ENV_FILE"
  export "$key=$value"
}

sanitize_postgres_identifier() {
  local raw="${1:-$APP_NAME}"
  local value

  value="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr '-' '_' | tr -cd 'a-z0-9_')"
  value="${value#_}"
  value="${value%_}"

  if [[ -z "$value" ]]; then
    value="app"
  fi

  if [[ "$value" =~ ^[0-9] ]]; then
    value="app_${value}"
  fi

  printf '%.63s\n' "$value"
}

generate_postgres_password() {
  require_command openssl
  openssl rand -hex 24
}

generate_dkim_encryption_key() {
  require_command openssl
  openssl rand -hex 32
}

ensure_dkim_encryption_key() {
  if [[ -n "${DKIM_ENCRYPTION_KEY:-}" ]]; then
    return 0
  fi

  local dkim_encryption_key
  dkim_encryption_key="$(generate_dkim_encryption_key)"
  upsert_env "DKIM_ENCRYPTION_KEY" "$dkim_encryption_key"
  log "Generated DKIM_ENCRYPTION_KEY and saved it in $ENV_FILE"
}

start_postgres_service() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files postgresql.service >/dev/null 2>&1; then
      sudo systemctl enable --now postgresql >/dev/null 2>&1 || true
    fi

    local postgres_unit=""
    postgres_unit="$(
      systemctl list-unit-files --type=service --no-legend 'postgresql*.service' 2>/dev/null \
        | awk 'NR == 1 { print $1 }'
    )"
    if [[ -n "$postgres_unit" ]]; then
      sudo systemctl enable --now "$postgres_unit" >/dev/null 2>&1 || true
    fi
  fi

  if command -v service >/dev/null 2>&1; then
    sudo service postgresql start >/dev/null 2>&1 || true
  fi
}

run_as_postgres() {
  if [[ "$(id -un)" == "postgres" ]]; then
    "$@"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo -u postgres "$@"
    return 0
  fi

  if command -v runuser >/dev/null 2>&1; then
    runuser -u postgres -- "$@"
    return 0
  fi

  echo "Need sudo or runuser to execute PostgreSQL administration commands as the 'postgres' user." >&2
  exit 1
}

ensure_postgres_ready() {
  require_command psql

  if run_as_postgres psql -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
    return 0
  fi

  log "Starting local PostgreSQL service"
  start_postgres_service

  local attempt
  for attempt in $(seq 1 15); do
    if run_as_postgres psql -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "PostgreSQL is not ready. Install PostgreSQL and ensure the 'postgres' system user exists, then rerun deploy.sh." >&2
  exit 1
}

provision_local_postgres() {
  local postgres_db
  local postgres_role
  local postgres_password
  local database_url

  postgres_db="$(sanitize_postgres_identifier "$APP_NAME")"
  postgres_role="$(sanitize_postgres_identifier "${APP_NAME}_app")"
  postgres_password="$(generate_postgres_password)"
  database_url="postgresql://${postgres_role}:${postgres_password}@127.0.0.1:5432/${postgres_db}"

  log "Provisioning local PostgreSQL database '$postgres_db' for role '$postgres_role'"

  if run_as_postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${postgres_role}'" | grep -q '^1$'; then
    run_as_postgres psql -v ON_ERROR_STOP=1 -d postgres \
      -c "ALTER ROLE \"${postgres_role}\" WITH LOGIN PASSWORD '${postgres_password}'"
  else
    run_as_postgres psql -v ON_ERROR_STOP=1 -d postgres \
      -c "CREATE ROLE \"${postgres_role}\" WITH LOGIN PASSWORD '${postgres_password}'"
  fi

  if run_as_postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${postgres_db}'" | grep -q '^1$'; then
    run_as_postgres psql -v ON_ERROR_STOP=1 -d postgres \
      -c "ALTER DATABASE \"${postgres_db}\" OWNER TO \"${postgres_role}\""
  else
    run_as_postgres psql -v ON_ERROR_STOP=1 -d postgres \
      -c "CREATE DATABASE \"${postgres_db}\" OWNER \"${postgres_role}\""
  fi

  run_as_postgres psql -v ON_ERROR_STOP=1 -d postgres \
    -c "GRANT ALL PRIVILEGES ON DATABASE \"${postgres_db}\" TO \"${postgres_role}\""

  upsert_env "DATABASE_URL" "$database_url"
  log "Generated a new local PostgreSQL password and saved DATABASE_URL in $ENV_FILE"
}

prepare_database() {
  if is_enabled "${USE_LOCAL_POSTGRES:-true}"; then
    log "USE_LOCAL_POSTGRES=true; using the local PostgreSQL server"
    ensure_postgres_ready

    if [[ -n "${DATABASE_URL:-}" ]]; then
      log "DATABASE_URL is already set; reusing existing local PostgreSQL credentials without regenerating the password"
    else
      log "DATABASE_URL is blank; provisioning local PostgreSQL credentials and generating a new password"
      provision_local_postgres
    fi
  elif [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL must be set in $ENV_FILE when USE_LOCAL_POSTGRES=false" >&2
    exit 1
  else
    log "USE_LOCAL_POSTGRES=false; using the configured DATABASE_URL"
  fi
}

detect_public_ipv4() {
  local ip=""
  local url

  if command -v dig >/dev/null 2>&1; then
    ip="$(
      {
        dig +short -4 myip.opendns.com @resolver1.opendns.com 2>/dev/null || true
      } \
        | awk 'NF { print; exit }'
    )"
    if is_public_ipv4 "$ip"; then
      printf '%s\n' "$ip"
      return 0
    fi
  fi

  if command -v curl >/dev/null 2>&1; then
    for url in \
      "https://api.ipify.org" \
      "https://checkip.amazonaws.com"
    do
      ip="$(
        curl --silent --show-error --fail --max-time 5 "$url" 2>/dev/null || true
      )"
      ip="$(
        printf '%s' "$ip" \
          | tr -d '[:space:]'
      )"
      if is_public_ipv4 "$ip"; then
        printf '%s\n' "$ip"
        return 0
      fi
    done
  fi

  return 1
}

ensure_server_ip() {
  if [[ -n "${SERVER_IP:-}" && "${SERVER_IP}" != "your-server-ip" ]]; then
    return 0
  fi

  local detected_ip
  if detected_ip="$(detect_public_ipv4)"; then
    upsert_env "SERVER_IP" "$detected_ip"
    log "Detected public IPv4 $detected_ip and updated SERVER_IP in $ENV_FILE"
    return 0
  fi

  log "Could not auto-detect SERVER_IP; set it manually in $ENV_FILE if DNS verification needs it"
}

build_smtp_cert_site_block() {
  if [[ -z "${SMTP_BANNER_HOSTNAME:-}" ]]; then
    return 0
  fi

  if [[ "$SMTP_BANNER_HOSTNAME" == "${APP_DOMAIN:-}" || "$SMTP_BANNER_HOSTNAME" == "${APP_WWW_DOMAIN:-}" ]]; then
    return 0
  fi

  cat <<EOF
${SMTP_BANNER_HOSTNAME} {
	respond "" 204
}
EOF
}

render_caddyfile() {
  local rendered="$1"
  local site_addresses="$APP_DOMAIN"
  local upstream="127.0.0.1:${PORT:-3000}"
  local smtp_cert_site_block
  smtp_cert_site_block="$(build_smtp_cert_site_block)"

  if [[ -n "${APP_WWW_DOMAIN:-}" ]]; then
    site_addresses="$site_addresses, $APP_WWW_DOMAIN"
  fi

  awk \
    -v admin_email="$CADDY_ADMIN_EMAIL" \
    -v site_addresses="$site_addresses" \
    -v upstream="$upstream" \
    -v smtp_cert_site_block="$smtp_cert_site_block" '
      /^__SMTP_CERT_SITE_BLOCK__$/ {
        if (length(smtp_cert_site_block)) {
          print smtp_cert_site_block
        }
        next
      }
      {
        gsub(/__CADDY_ADMIN_EMAIL__/, admin_email)
        gsub(/__SITE_ADDRESSES__/, site_addresses)
        gsub(/__UPSTREAM__/, upstream)
        print
      }
    ' "$TEMPLATE_PATH" > "$rendered"
}

configure_caddy() {
  require_command caddy
  require_file "$TEMPLATE_PATH"

  if [[ -z "${APP_DOMAIN:-}" ]]; then
    echo "APP_DOMAIN must be set in $ENV_FILE when CONFIGURE_CADDY=true" >&2
    exit 1
  fi

  if [[ -z "${CADDY_ADMIN_EMAIL:-}" ]]; then
    echo "CADDY_ADMIN_EMAIL must be set, or APP_DOMAIN must be set so it can derive automatically, when CONFIGURE_CADDY=true" >&2
    exit 1
  fi

  local rendered
  rendered="$(mktemp)"

  render_caddyfile "$rendered"
  caddy validate --config "$rendered"
  install_file "$rendered" "$CADDYFILE_PATH"
  rm -f "$rendered"

  reload_caddy
}

find_caddy_cert_pair() {
  local host="$1"
  local root

  while IFS= read -r root; do
    [[ -n "$root" && -d "$root" ]] || continue

    local cert
    cert="$(find "$root" -type f -path "*/certificates/*/$host/$host.crt" -print -quit 2>/dev/null || true)"
    if [[ -n "$cert" ]]; then
      local key="${cert%.crt}.key"
      if [[ -f "$key" ]]; then
        printf '%s\n%s\n' "$cert" "$key"
        return 0
      fi
    fi
  done < <(
    printf '%s\n' \
      "${CADDY_DATA_DIR:-}" \
      "/var/lib/caddy/.local/share/caddy" \
      "/var/lib/caddy" \
      "/root/.local/share/caddy" \
      "/home/caddy/.local/share/caddy" \
      "${HOME:-}/.local/share/caddy" \
      | awk 'NF && !seen[$0]++'
  )

  return 1
}

setup_smtp_certs_from_caddy() {
  if [[ -n "${SMTP_TLS_CERT_PATH:-}" && -n "${SMTP_TLS_KEY_PATH:-}" && -f "${SMTP_TLS_CERT_PATH}" && -f "${SMTP_TLS_KEY_PATH}" ]]; then
    log "SMTP TLS files already configured"
    return 0
  fi

  if [[ -z "${SMTP_BANNER_HOSTNAME:-}" ]]; then
    echo "SMTP_BANNER_HOSTNAME must be set, or APP_DOMAIN must be set so it can derive automatically, before SMTP cert setup can run" >&2
    exit 1
  fi

  if ! is_enabled "$CONFIGURE_CADDY"; then
    echo "CONFIGURE_CADDY must be enabled for automatic SMTP cert setup" >&2
    exit 1
  fi

  local cert_pair=()
  local attempt
  for attempt in $(seq 1 15); do
    if mapfile -t cert_pair < <(find_caddy_cert_pair "$SMTP_BANNER_HOSTNAME"); then
      break
    fi

    if (( attempt == 1 )); then
      log "Waiting for Caddy to provision a certificate for $SMTP_BANNER_HOSTNAME"
    fi
    sleep 2
  done

  if (( ${#cert_pair[@]} != 2 )); then
    echo "Could not locate a Caddy-managed certificate for $SMTP_BANNER_HOSTNAME. Ensure DNS for that host points to this server, then rerun './deploy.sh setup'." >&2
    exit 1
  fi

  local target_dir="$SCRIPT_DIR/runtime/smtp-certs/$SMTP_BANNER_HOSTNAME"
  local target_cert="$target_dir/fullchain.pem"
  local target_key="$target_dir/privkey.pem"

  install_copied_file "${cert_pair[0]}" "$target_cert" 0644
  install_copied_file "${cert_pair[1]}" "$target_key" 0600

  upsert_env "SMTP_TLS_CERT_PATH" "$target_cert"
  upsert_env "SMTP_TLS_KEY_PATH" "$target_key"

  log "SMTP TLS files copied to $target_dir and .env updated"
}

validate_env() {
  local require_smtp_files="${1:-false}"
  CHECK_ERRORS=0
  CHECK_WARNINGS=0

  echo "[check] Validating environment"

  if is_valid_port "${PORT:-}"; then
    check_ok "PORT=${PORT}"
  else
    check_error "PORT must be a valid TCP port"
  fi

  if is_valid_port "${SMTP_PORT:-}"; then
    check_ok "SMTP_PORT=${SMTP_PORT}"
  else
    check_error "SMTP_PORT must be a valid TCP port"
  fi

  if is_enabled "${USE_LOCAL_POSTGRES:-true}"; then
    if command -v psql >/dev/null 2>&1; then
      check_ok "USE_LOCAL_POSTGRES=true and psql is available"
    else
      check_error "USE_LOCAL_POSTGRES=true requires psql to be installed"
    fi

    if [[ -n "${DATABASE_URL:-}" ]]; then
      check_ok "DATABASE_URL is set"
    else
      check_warn "DATABASE_URL is blank and will be generated from a local PostgreSQL role during deploy"
    fi
  elif [[ -n "${DATABASE_URL:-}" ]]; then
    check_ok "DATABASE_URL is set"
  else
    check_error "DATABASE_URL is missing"
  fi

  if [[ "${DKIM_ENCRYPTION_KEY:-}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    check_ok "DKIM_ENCRYPTION_KEY is a 64-character hex key"
  else
    check_error "DKIM_ENCRYPTION_KEY must be 64 hex characters"
  fi

  if [[ -n "${SERVER_IP:-}" && "${SERVER_IP}" != "your-server-ip" ]]; then
    check_ok "SERVER_IP=${SERVER_IP}"
  else
    check_warn "SERVER_IP is unset or still using the example placeholder"
  fi

  if [[ -n "${SMTP_BANNER_HOSTNAME:-}" ]]; then
    check_ok "SMTP_BANNER_HOSTNAME=${SMTP_BANNER_HOSTNAME}"
  else
    check_warn "SMTP_BANNER_HOSTNAME is unset; set APP_DOMAIN or SMTP_BANNER_HOSTNAME to a public mail hostname"
  fi

  if [[ -n "${ATTACHMENTS_DIR:-}" ]]; then
    check_ok "ATTACHMENTS_DIR=${ATTACHMENTS_DIR}"
  else
    check_error "ATTACHMENTS_DIR is missing"
  fi

  if is_enabled "${CONFIGURE_CADDY:-}"; then
    if [[ -n "${APP_DOMAIN:-}" && "${APP_DOMAIN}" != "example.com" ]]; then
      check_ok "APP_DOMAIN=${APP_DOMAIN}"
    else
      check_error "APP_DOMAIN is missing or still using the example value"
    fi

    if [[ -n "${CADDY_ADMIN_EMAIL:-}" ]]; then
      check_ok "CADDY_ADMIN_EMAIL is set"
    else
      check_error "CADDY_ADMIN_EMAIL is missing and could not be derived from APP_DOMAIN"
    fi
  else
    check_warn "CONFIGURE_CADDY is disabled; web proxy configuration will be skipped"
  fi

  if [[ -n "${SMTP_TLS_CERT_PATH:-}" || -n "${SMTP_TLS_KEY_PATH:-}" ]]; then
    if [[ -z "${SMTP_TLS_CERT_PATH:-}" || -z "${SMTP_TLS_KEY_PATH:-}" ]]; then
      check_error "SMTP_TLS_CERT_PATH and SMTP_TLS_KEY_PATH must be set together"
    else
      if [[ -f "${SMTP_TLS_CERT_PATH}" ]]; then
        check_ok "SMTP TLS cert exists at ${SMTP_TLS_CERT_PATH}"
      else
        check_error "SMTP TLS cert file not found at ${SMTP_TLS_CERT_PATH}"
      fi

      if [[ -f "${SMTP_TLS_KEY_PATH}" ]]; then
        check_ok "SMTP TLS key exists at ${SMTP_TLS_KEY_PATH}"
      else
        check_error "SMTP TLS key file not found at ${SMTP_TLS_KEY_PATH}"
      fi
    fi
  elif [[ "$require_smtp_files" == "true" || "${NODE_ENV:-development}" == "production" ]]; then
    check_error "SMTP TLS paths are not configured"
  else
    check_warn "SMTP TLS paths are not configured"
  fi

  echo "[check] ${CHECK_ERRORS} error(s), ${CHECK_WARNINGS} warning(s)"

  (( CHECK_ERRORS == 0 ))
}

prepare_runtime_paths() {
  ensure_directory "${ATTACHMENTS_DIR:-$SCRIPT_DIR/attachments}"
  ensure_directory "$SCRIPT_DIR/runtime"
}

deploy_app() {
  require_command pnpm
  require_command pm2

  cd "$SCRIPT_DIR"
  prepare_runtime_paths

  log "Installing dependencies"
  pnpm install --frozen-lockfile

  log "Running database migrations"
  pnpm run migrate

  log "Starting application with PM2"
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
  else
    pm2 start src/index.js --name "$APP_NAME" --update-env
  fi
  pm2 save
}

run_setup() {
  ensure_server_ip
  ensure_dkim_encryption_key
  prepare_database
  validate_env false

  if is_enabled "$CONFIGURE_CADDY"; then
    log "Rendering Caddy configuration"
    configure_caddy
  fi

  log "Configuring SMTP TLS files"
  setup_smtp_certs_from_caddy

  validate_env true
  deploy_app
  log "Setup complete"
}

run_check() {
  validate_env false
}

run_deploy() {
  prepare_database

  if is_enabled "$CONFIGURE_CADDY"; then
    log "Rendering Caddy configuration"
    configure_caddy
  fi

  deploy_app
  log "Deployment complete"
}

case "$MODE" in
  deploy|"")
    ;;
  setup|check)
    ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

load_env_file
derive_env_from_app_domain

case "$MODE" in
  setup)
    run_setup
    ;;
  check)
    run_check
    ;;
  deploy|"")
    run_deploy
    ;;
esac
