# PingTower

PingTower is a small uptime and latency monitor. The Node/Express API stores
projects and check history in MongoDB; the React/Vite client displays recent
health, uptime, and response-time data.

## Requirements

- Node.js 20 or newer
- MongoDB 6 or newer, or a MongoDB Atlas URI

The application intentionally uses MongoDB in every committed runtime path. A
local database (or Atlas database) is required; no fallback database is included
in the repository.

## Run locally

```bash
# install both workspaces
npm install

# configure the API
cp server/.env.example server/.env
# edit server/.env and set MONGO_URI
# set a stable CRON_SECRET for scheduled checks

# terminal 1
npm run dev:server

# terminal 2
npm run dev:client
```

Open the Vite URL printed in the client terminal. The client uses a relative
`/api` path and Vite proxies it to the API at port 5000.

For production, set `NODE_ENV=production`, use a random `CRON_SECRET` of at
least 32 characters, set `CORS_ORIGIN` to the dashboard origin, and keep
`ALLOW_PRIVATE_TARGETS=false`.

To send down/recovery emails, configure SMTP in `server/.env` and set
`MAIL_ENABLED=true`. `SMTP_SECURE=true` is normally used with port 465; port 587
normally uses `SMTP_SECURE=false` with STARTTLS. Example settings:

```dotenv
MAIL_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
MAIL_FROM=PingTower <alerts@example.com>
```

SMTP failures are logged and do not prevent check history from being recorded.
A failed down-alert remains eligible for retry on the next check. Credentials
must stay in `server/.env` or your deployment secret manager.

The internal scheduler endpoint is:

```text
POST /api/internal/run-checks
x-cron-secret: <CRON_SECRET>
```

Use an external scheduler for this endpoint when running more than one API
replica. If `ENABLE_LOCAL_CRON=true`, run only one scheduler replica.

## Checks and build

```bash
npm test                 # server unit and mail tests without Mongo
npm run lint             # client lint
npm run build            # client production build

# requires a running MongoDB and the integration environment variables
RUN_INTEGRATION=1 npm run test:integration --workspace server
```

GitHub Actions runs the unit, mail, Mongo integration, lint, and build checks.
The optional `server/dev/smoke*.js` scripts exercise the complete Mongo-backed
API with `mongodb-memory-server`; they may download a MongoDB binary on their
first run. A real `MONGO_URI` is used by the application itself.

## API outline

- `GET /api/health` — process and database status
- `GET /api/projects` — projects plus the latest 48 checks and summary metrics
- `POST /api/projects` — create a monitor (`name`, `url`, `alertEmail`)
- `GET /api/projects/:id` — retrieve one monitor and its metrics
- `PATCH /api/projects/:id` — update monitor fields or pause/resume it
- `DELETE /api/projects/:id` — delete a monitor and its history
- `POST /api/projects/:id/check` — run one rate-limited on-demand check
- `POST /api/internal/run-checks` — authenticated scheduler entry point

The checker only permits HTTP(S), rejects private/reserved address space, pins
DNS results for the request, validates every redirect hop, caps response body
consumption, and sends a descriptive User-Agent. `ALLOW_PRIVATE_TARGETS` is a
development-only escape hatch and must not be enabled on a public server.
