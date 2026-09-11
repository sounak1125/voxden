# Deploying the account service

One small VPS, one domain, three files. The service is a single Node process
with a SQLite file; Caddy in front does TLS. Nothing here needs more than the
cheapest instance at any provider (1 vCPU, 1 GB is plenty).

## What you need first

- A domain or subdomain, for example `account.voxden.app`, with an **A record**
  pointing at the VPS. Caddy will not get a certificate until DNS resolves.
- Ubuntu 22.04 or 24.04 with Docker. On a fresh machine:

  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

- The container image. It is built by `.github/workflows/account-service.yml`
  on every push to `main` that touches `server/` and published as
  `ghcr.io/sounak1125/voxden-account:latest` (and `:<git sha>`). Make the
  package public in GitHub → Packages once, or log the VPS in with
  `docker login ghcr.io`.

## Bring it up

```bash
git clone https://github.com/sounak1125/voxden.git
cd voxden/deploy
cp .env.example .env
nano .env            # at minimum: ACCOUNT_DOMAIN. Add keys as you get them.
docker compose up -d
```

Check it:

```bash
curl https://account.voxden.app/healthz
docker compose logs -f account
```

Ports 80 and 443 must be open in the provider's firewall. Everything else
stays inside the compose network.

## The app already knows the address

Every build talks to `https://account.voxden.app/v1`, so once the A record
for `account.voxden.app` points at this machine and the stack is up, the app
needs no change. To test a staging or local instance, run the app with:

```
VOXDEN_ACCOUNT_URL=https://account.staging.example/v1
```

The sign-in sender defaults to `sign-in@voxden.app` (`MAIL_FROM` overrides
it) and the relay identifies itself to the speech model as `https://voxden.app`.

## First sign-in without email

With `RESEND_API_KEY` empty, codes go to the container log:

```bash
docker compose logs -f account | grep '\[mail\]'
```

Request a code from the app, read it there, type it in. That is enough to
test the whole loop before a mail provider exists.

## Grant yourself Pro

```bash
docker compose exec account node grant.js you@example.com pro 2027-01-01
```

The app picks it up on Refresh under Settings › Account.

## Keys, in the order they pay off

1. `RESEND_API_KEY` and `MAIL_FROM`: real sign-in emails. Verify the sending
   domain in Resend first.
2. `OPENROUTER_API_KEY`: cloud transcription. Watch the OpenRouter usage
   page for the first day.
3. Payments. See the Payments section in `../server/README.md` for the
   provider-side setup and webhook URLs.

After any `.env` change:

```bash
docker compose up -d
```

## Updating

```bash
docker compose pull
docker compose up -d
```

The database is a named volume (`account-data`) and survives pulls, restarts
and image changes. To pin a build, set `ACCOUNT_IMAGE_TAG` to a git SHA.

## Backups

The `backup` service writes a consistent snapshot to `/data/backups` inside
the volume every 24 hours and keeps the newest 14. To copy the latest one off
the machine:

```bash
docker compose cp account:/data/backups ./backups
```

To take one by hand:

```bash
docker compose exec account node backup.js
```

Restoring is stopping the stack, replacing `/data/voxden.sqlite` in the
volume with a backup, and starting it again.

## Without Docker

Node 22.5 or newer, a checkout, and a process manager:

```bash
cd server
PORT=8787 VOXDEN_DB=/var/lib/voxden/voxden.sqlite RESEND_API_KEY=... node index.js
```

Put Caddy or nginx in front for TLS, forwarding to `127.0.0.1:8787` with
`X-Forwarded-For` set. The `Caddyfile` here works as is with
`reverse_proxy 127.0.0.1:8787`.
