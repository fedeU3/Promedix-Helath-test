# USGS Earthquake Poller

A small NestJS service that polls the [USGS earthquake feed](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) every 5 minutes, stores events in Postgres without duplicates, and serves the largest recent quakes as JSON. It is built to keep working when the feed is down, slow, or returns garbage.

## Run it

Requirements: Node 20.19+, Docker.

```bash
docker compose up -d db     # Postgres 16 (also creates a quakes_test database for tests)
cp .env.example .env
npm install
npm run build && npm run start:prod
```

For development, `npm run start:dev` rebuilds on change.

```bash
curl localhost:3000/earthquakes              # largest quakes, last 24h
curl "localhost:3000/earthquakes?hours=6&limit=5"
curl localhost:3000/health
```

Tests (need the Docker Postgres running):

```bash
npm test
```

### Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | — (required) | Any Postgres connection string |
| `PORT` | `3000` | |
| `POLL_INTERVAL_MS` | `300000` (5 min) | |
| `FEED_URL` | USGS `all_hour` | Normal poll |
| `BACKFILL_FEED_URL` | USGS `all_day` | Used after a gap (see below) |

## Endpoints

- **`GET /earthquakes?hours=24&limit=20`**: quakes in the last `hours` (1–168), largest magnitude first, at most `limit` (1–100). Events without a magnitude are excluded. `dataAsOf` says when the data was last refreshed.
- **`GET /health`**: poller status (last attempt, last success, last error, consecutive failures) and database reachability. Returns **503** if the database is down or the last successful poll is older than 3 intervals. It's meant for an external uptime monitor.

## How it handles failure

Each poll cycle either stores a fully validated payload or stores nothing. No error can escape a cycle, and the next cycle is always scheduled.

| Failure | What happens |
|---|---|
| Feed unreachable (DNS, refused, reset) | Cycle fails, logged, retried with backoff |
| Feed hangs, or stalls mid-body | 10 s timeout on the whole request, including reading the body |
| Non-200 status | Treated as failure; `Retry-After` is honored (e.g. on 429) |
| Garbage, HTML error page, truncated JSON | `JSON.parse` fails, cycle fails, database untouched |
| Valid JSON, wrong shape | Envelope validation fails, cycle fails, database untouched |
| One malformed event among valid ones | That event is skipped and counted; the rest are stored |
| Every event malformed | Treated as failure (most likely an upstream format change) |
| Oversized response | Reading stops at 10 MB |
| Postgres down | Cycle fails and backs off; API returns 503; process stays up |
| Crash mid-write | All upserts in a cycle share one transaction, so it rolls back |
| Process crash / reboot | systemd restarts it (see Deployment) |

**Backoff.** After a failure the next attempt is in 30 s, doubling on each consecutive failure (±20% jitter), capped at 15 minutes. The first success returns to the normal 5-minute interval.

**Scheduling.** The next cycle is scheduled only after the current one finishes (`setTimeout`, not `setInterval`), so cycles can never overlap.

**Gaps.** `all_hour` only covers the last 60 minutes. On startup, or when the last success is more than 45 minutes old, the poller fetches `all_day` once instead, so an outage shorter than a day leaves no hole in the 24-hour view.

## Storage and idempotency

The natural key is the USGS event `id` (e.g. `us7000abcd`), the table's primary key.

USGS revises events after publishing them (magnitude, location, review status) and bumps `properties.updated`. So the write is an upsert that only applies newer data:

```sql
INSERT ... ON CONFLICT (id) DO UPDATE SET ...
WHERE excluded.updated_at > earthquakes.updated_at
```

- Polling the same data again changes nothing.
- A newer revision replaces the old row.
- A stale response arriving late cannot overwrite newer data.

Rows are upserted one at a time inside the transaction. A single multi-row `INSERT ... ON CONFLICT` would fail if the same id appears twice in one payload. The full original feature is kept in a `raw jsonb` column, so fields we don't use yet aren't lost.

The table is created on the first poll (`CREATE TABLE IF NOT EXISTS`). With one table, a migration tool isn't worth it.

## Key decisions

- **NestJS.** It's what I work in daily. For a service this size, plain Node would also be fine; the Nest-specific parts are only the module wiring and the two controllers.
- **Raw SQL with `pg`, no ORM.** There's one table and three queries, and the conditional upsert is the core of the idempotency story, so it should be visible SQL.
- **No HTTP or validation library.** Node's built-in `fetch` plus a hand-written validator. The validator is about 60 lines and has no dependencies.
- **Poller and API in one process.** It needs one command and one systemd unit. If the process dies, both come back together.
- **Tests hit a real Postgres and a fake local HTTP server**, not mocks, so the upsert SQL and the network error paths are what actually get tested.

## Deployment (Linux VPS)

`deploy/quakes.service` is a systemd unit. Installation steps are at the top of the file.

- **Crashes:** `Restart=always` with `RestartSec=5`. At that pace systemd never hits its default start rate limit, so it keeps retrying indefinitely.
- **Reboots:** `systemctl enable` plus `WantedBy=multi-user.target`.
- **Clean shutdown:** on `SIGTERM`, Nest's shutdown hooks stop the timer, wait for an in-flight poll to commit, then close the pool.
- **Logs:** stdout to journald (`journalctl -u quakes -f`).
- **Running but not working:** systemd can't detect a process that is alive but not updating data. That's what `/health` is for: point an external uptime check (UptimeRobot, a cron `curl`, etc.) at it.

Postgres can run on the same VPS or be any hosted Postgres; only `DATABASE_URL` changes.

## Deliberately left out

- Auth, a UI, Docker for the app itself, an ORM, migrations tooling: not needed at this size.
- **Data retention.** Rows are kept forever, which is a few hundred rows a day.
- **Merged events.** USGS sometimes merges detections from different networks, and the same quake can later appear under another id (listed in `properties.ids`). This could briefly create two rows for one quake. Handling it properly means tracking alternate ids.
- **Deleted events.** Events USGS retracts just stop appearing in the feed; we keep the last version we saw.
- Metrics and alerting beyond `/health` and logs.

## What I'd do next

1. Handle merged event ids using `properties.ids`.
2. Emit a metric or alert when `consecutiveFailures` crosses a threshold, instead of relying on an external uptime check.
3. Add a retention job if this ran for months.

## Use of AI tools

I used Claude Code (Claude) to plan the design and write most of the code. I made the decisions, reviewed the output, and tested it myself.

**Where I steered or overrode it**

- **Stack.** It first proposed Python. I switched to NestJS to match what I use daily, and copied my existing project's TypeScript setup.
- **Database.** I considered Supabase. We settled on plain Postgres through the `pg` driver with Docker for local use, so reviewers don't need an account and no SDK is involved.
- **Scope.** I dropped ESLint and kept only Prettier. I picked Jest over Cypress (which I know better) because there is no UI to test.
- **Process.** It started writing code before I had approved the plan. I had it delete everything and only build once we had agreed on the full design.
- **Second opinion.** A developer friend suggested a plain `fetch` in a `setInterval`. I kept the simple `fetch`, but the design moved to `setTimeout` with backoff (no overlapping polls) and explicit timeout, status and JSON checks, since `fetch` alone doesn't fail on a 500 or a hang.

**Where it was wrong**

- **Timeout bug.** The tests caught that timeouts were being reported as network errors. The error-name check it wrote doesn't work under Jest. It now checks the request's own abort signal.
- **Comments.** I wrote the explanatory comments myself, then had them reviewed. Some of my claims were wrong or unverified (for example, `pg` has no default connection timeout, and there's no evidence USGS sends bad envelopes), so I corrected them.

**How I verified it**

- 50 automated tests against a real Postgres and a fake USGS server.
- Called the endpoints with Postman.
- Inspected the table in DBeaver to confirm there are no duplicate ids.
- Cleared the table and watched the poller refill it from the live feed.
