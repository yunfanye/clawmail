# Deployment

Keep infrastructure and app code separate:

- `src/` contains the Node.js application
- `deploy/` contains host-level deployment config such as reverse proxies and service wiring

## Caddy

This repo's app listens on port `3000` by default. The deploy script reads `.env`, renders a Caddy config, and installs it so Caddy can bind to ports `80` and `443`, terminate TLS, and proxy traffic to the local app.

### Files

- `deploy/Caddyfile.template` is the production reverse proxy template
- `deploy.sh` is the main deployment entrypoint

### Setup

1. Copy `.env.example` to `.env`
2. Set `APP_DOMAIN`
3. Optionally override `APP_WWW_DOMAIN`, `CADDY_ADMIN_EMAIL`, or `SMTP_BANNER_HOSTNAME`; when left blank they derive to `www.<APP_DOMAIN>`, `admin@<APP_DOMAIN>`, and `mx.<APP_DOMAIN>`
4. Leave `SMTP_TLS_KEY_PATH` and `SMTP_TLS_CERT_PATH` blank for first-time setup if you want the script to source them from Caddy
5. Leave `PORT=3000` for the app's internal listener
6. Keep `TRUST_PROXY=1` when running behind Caddy
7. Point DNS for both the app hostname and `SMTP_BANNER_HOSTNAME` at this server
8. Install Caddy, PM2, pnpm, OpenSSL, and PostgreSQL on the server
9. Leave `USE_LOCAL_POSTGRES=true` to have `deploy.sh` create a dedicated local database user with a random password the first time `DATABASE_URL` is blank, then reuse that saved `DATABASE_URL` on later deploys
10. If you prefer an external database, set `USE_LOCAL_POSTGRES=false` and provide `DATABASE_URL` yourself
11. Run the first-time setup:

```bash
./deploy.sh setup
```

After the first setup succeeds, normal redeploys use:

```bash
./deploy.sh
```

`./deploy.sh setup` will:

- validate `.env`
- provision a local PostgreSQL role/database when `USE_LOCAL_POSTGRES=true`
- install dependencies
- run migrations
- render `/etc/caddy/Caddyfile` from `.env`
- validate and reload Caddy
- wait for a Caddy-managed certificate for `SMTP_BANNER_HOSTNAME`
- copy the SMTP cert and key into `runtime/smtp-certs/<hostname>/`
- write `SMTP_TLS_CERT_PATH` and `SMTP_TLS_KEY_PATH` back into `.env`
- write the generated local `DATABASE_URL` back into `.env` when it is blank
- start or restart the PM2 app process

`./deploy.sh check` validates `.env` and file paths without changing the system.

### App process

Keep the Node app private on the machine:

- Run Clawmail on port `3000`
- Do not expose port `3000` publicly in the firewall
- Expose `80` and `443` for Caddy

### Notes

- DNS cannot forward a hostname to port `3000`; that requires a reverse proxy or moving the app to `80/443`
- Caddy automatically provisions HTTPS certificates after DNS points at the server
- The deploy script uses `sudo` only for writing `/etc/caddy/Caddyfile` and reloading Caddy
- `TRUST_PROXY=1` is important so Express rate limiting and client IP handling work correctly behind Caddy
- The setup flow adds a lightweight Caddy site block for `SMTP_BANNER_HOSTNAME` when it differs from `APP_DOMAIN` so Caddy can obtain a certificate for SMTP STARTTLS
- SMTP certs are copied from Caddy into `runtime/smtp-certs/`; rerun `./deploy.sh setup` after certificate renewal if you want to refresh those copies
