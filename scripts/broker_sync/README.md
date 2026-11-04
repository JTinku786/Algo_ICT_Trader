# Broker-truth sync

Pulls what Angel One, Dhan and Groww **actually** hold into Postgres, so the
Account Management page stops inferring account state from the algo's own log.

The old page read only `realtime_production_broker_order_executions` — orders the
algo placed. Anything else on those accounts (manual trades, broker-side
rejections, real fill prices, real closed positions, funds, charges) was
invisible. These tables fix that.

## What gets pulled

| Dataset     | Angel One | Dhan | Groww | Notes |
|-------------|-----------|------|-------|-------|
| `orders`    | ✅ day    | ✅ day | ✅ day | includes rejected orders with the broker's reason |
| `trades`    | ✅ day    | ✅ day + history | ⚠️ per-order | Dhan trade history carries per-trade charges |
| `positions` | ✅ day    | ✅ day | ✅ day | open **and** closed-for-the-day, with realized / unrealized P&L |
| `funds`     | ✅        | ✅    | ✅    | cash, utilised margin, collateral |
| `ledger`    | ❌        | ✅ range | ❌ | only Dhan publishes a ledger endpoint |

Angel One's and Groww's books are **day scoped** — there is no historical API. A
day the sync misses at those brokers cannot be recovered later, which is exactly
why this runs daily and records a watermark per dataset.

Groww has no account-wide trade book either. The adapter asks for per-order fills
when the installed SDK supports it and otherwise derives one fill row from the
order's own broker-confirmed average price, tagged `_derived_from` in `raw` so
nothing downstream mistakes it for an exchange trade record.

## History: what is and is not retrievable

This is the single most important constraint in this folder.

| Broker | Orders | Fills | Positions | Ledger |
|---|---|---|---|---|
| Angel One | **today only** | **today only** | **today only** | no endpoint |
| Groww | **today only** | per-order, today | **today only** | no endpoint |
| Dhan | today only | **dated history** | today only | **dated history** |

Angel One's and Groww's books reset at the daily rollover and neither publishes a
dated endpoint, so a day nobody captured is gone. Dhan is the only one that can
be asked about the past.

`probe_history.py` verifies this against the live accounts rather than trusting
the table above — it logs in, lists what each SDK actually exposes, and reports
how far back each dated endpoint really goes.

`backfill_history.py` recovers the rest from what is already on disk:

* `realtime_production_broker_order_executions` and
  `realtime_production_broker_order_exit_events` carry the broker's order id and
  broker-confirmed fill price for every entry and exit the algo ever placed
* every fill on record — including Dhan's real trade history — is run through an
  average-cost ledger to produce one position row per account, per day, per
  contract, with realised P&L matched across days for carry-forward positions

Every row carries `source_feed`:

| Value | Meaning | Rank |
|---|---|---|
| `broker_api` | the broker API returned this row | highest |
| `derived_trades` | computed from broker-returned fills | middle |
| `execution_audit` | reconstructed from the algo's own records | lowest |

The upsert enforces that ranking, so a reconstructed row can never overwrite a
live one, and the dashboard labels each row Broker / Derived / Rebuilt.

Nothing is invented. A fill with no broker-confirmed price produces no trade row
and contributes nothing to a position.

```bash
python probe_history.py                        # what will each broker actually give us?
python backfill_history.py                     # report only, writes nothing
python backfill_history.py --apply             # write
python backfill_history.py --apply --since 2026-01-01
```

Safe to re-run at any time. Worth re-running after a sync, since new Dhan trade
history extends the derived position rows.

## Tables

```
realtime_production_broker_orders                   one row per broker order
realtime_production_broker_trades                   one row per fill
realtime_production_broker_positions                per account, per day, per contract
realtime_production_broker_funds                    per account, per day
realtime_production_broker_ledger                   Dhan ledger entries
realtime_production_broker_sync_watermarks          max update time per dataset
realtime_production_broker_sync_runs                run ledger for alerting
realtime_production_broker_reconciliation_issues    algo vs broker disagreements
```

`orders`, `trades` and `positions` additionally carry `source_feed` (see above).

Every row is keyed on a deterministic uid, so re-running a day updates rather
than duplicates. The sync also upserts `realtime_production_customers` and
`realtime_production_customer_broker_accounts`, which is what removes the
`legacy_unlinked` accounts the dashboard used to invent.

## Running it

```bash
python sync_broker_accounts.py --schema-only     # create the tables, once
python sync_broker_accounts.py                   # all accounts, all datasets
python sync_broker_accounts.py --dry-run         # fetch and print, write nothing
python sync_broker_accounts.py --brokers groww
python sync_broker_accounts.py --datasets orders trades
python sync_broker_accounts.py --backfill-days 180
python selftest.py                               # offline: no DB, no broker, no SDK
```

Exit code is `0` when every enabled dataset succeeded or was legitimately
unsupported, `1` when at least one failed — so cron can alert on it.

### Scheduling (WSL Ubuntu cron — the real one)

```bash
bash install_cron.sh          # shows a diff, backs up, then installs
bash install_cron.sh --yes    # no prompt
bash install_cron.sh --remove
```

Installs one managed block at the end of the crontab:

```
0 6,7,9,11 * * 1-5 .../broker_truth_sync_india.sh >> .../logs/broker_sync_cron.log 2>&1
```

**Why four slots for one daily run.** The target is 16:30 IST. The crontab is
evaluated in `America/New_York`, where 16:30 IST is 07:00 ET under EDT and 06:00
ET under EST. `CRON_TZ=Asia/Kolkata` would have retimed every job listed after
it, which is not acceptable in a shared crontab — so all four slots fire and
`broker_truth_sync_india.sh` decides:

* it runs once the India clock reads 16:00 or later **and** today has not already
  been synced
* otherwise it logs `SKIP: ...` and exits 0

A day-marker under `logs/state/synced_<IST-date>.ok` guarantees exactly one real
run per India trading day. 09:00 and 11:00 ET are retries for a day where a
broker was unreachable at the first attempt — they cost nothing on a normal day.

### Logs

| Path | What |
|---|---|
| `logs/broker_sync_cron.log` | the crontab redirect; every slot appends here |
| `logs/broker_sync_<IST-date>.log` | per-day detail, kept 60 days |
| `logs/broker_sync_status.json` | last run: exit code, rows written, failures |
| `logs/broker_sync_runs.jsonl` | one line per run, append-only |
| `logs/broker_sync_latest.json` | full per-dataset summary from the last run |
| `logs/state/synced_*.ok` | day markers, kept 60 days |
| `logs/crontab.backup.*.txt` | crontab backups taken by `install_cron.sh` |

### Monitoring dashboard

`Cron_Monitoring_Streamlit/config/overrides.yaml` carries a
`broker_truth_sync_india` entry (critical, 900s timeout, `skip_pattern: 'SKIP: '`
so the no-op slots are not counted as work). After installing the cron block,
regenerate the registry so the job appears:

```bash
cd /mnt/c/Users/saite/Desktop/Cron_Monitoring_Streamlit
~/.venvs/cronmon/bin/python scripts/generate_registry.py
```

### Windows Task Scheduler (alternative)

`crontab.txt` has the two entries (America/New_York, matching the existing ICT
India schedule):

* **16:15 IST** — main pull, after the India close and before the brokers roll
  their day-scoped books over
* **21:00 IST** — late pass for `ledger trades funds`; Dhan posts settlement
  charges hours after the close

On Windows use `run_daily_sync.ps1` with Task Scheduler instead; the header of
that file has the `schtasks` command.

## Configuration

Credentials are **not** duplicated here. The adapters import the existing broker
config modules from `ICT_Automation/realtime_execution`:

> **`sync_config.py`, not `config.py`.** Both `realtime_execution` and
> `Updated_Notebook` ship a module called `config`. A file named `config.py` in
> this folder wins in `sys.modules`, and every broker module that does
> `from config import TABLES` then fails — which silently reduced the sync to
> whichever broker did not import `config` at all. Do not reintroduce that name.

| Broker    | Source module                     |
|-----------|-----------------------------------|
| Angel One | `angel_one_order_execution.py`    |
| Dhan      | `dhan_config.py` + `dhan_api.py`  |
| Groww     | `groww_config.py`                 |

| Variable | Default | Purpose |
|---|---|---|
| `ICT_AUTOMATION_ROOT` | auto-detected | where `realtime_execution/` lives |
| `PGHOST` / `POSTGRES_HOST` etc. | `172.26.224.1` | Postgres connection |
| `BROKER_SYNC_BACKFILL_DAYS` | `90` | first-run window for ranged datasets |
| `BROKER_SYNC_RANGE_CHUNK_DAYS` | `30` | max width of one range request |
| `BROKER_LIVE_SESSION_TTL` | `1800` | how long a live broker session is reused |
| `BROKER_LIVE_SNAPSHOT_TTL` | `10` | how long one snapshot is shared across tabs |
| `BROKER_LIVE_PERSIST_INTERVAL` | `300` | how often the live view writes through to the tables |

`accounts.local.json` (gitignored) overrides the discovered accounts without
touching code:

```json
{
  "groww:Titania_ICT_Algo": { "display_name": "Naveen", "customer_key": "naveen" },
  "dhan:Titania_Traders_Nishitha_Mukka": { "enabled": false }
}
```

## The website

* **Historical view** — `/api/account-management/history` reads these tables,
  directly from Postgres or through `backend/rest_api.py`
  (`/api/account-management/history/rows`).
* **Live view** — `/api/account-management/live` runs `live_snapshot.py` as a
  child process and reads its JSON from stdout. No Flask, no PowerShell, no
  tunnel: the credentials are already on this machine, so the shortest path is
  to run the Python. It fetches once when the tab is opened and then only when
  Refresh is clicked.

  The interpreter is `BROKER_SYNC_PYTHON`, defaulting to
  `C:\Users\saite\anaconda3\python.exe` on Windows. It needs SmartApi,
  growwapi, pyotp and psycopg2.

  Broker sessions are cached on disk — Angel One in `logs/state/angel_session.json`
  (0600, re-minted at the 05:00 IST rollover), Dhan and Groww by their own config
  modules — so the first call of the day pays for the TOTP logins and later
  refreshes are quick.

  This only works where the Python and the credentials live. For a hosted
  deployment set `BROKER_LIVE_MODE=bridge` and point `CANDLES_REST_API_URL` at a
  reachable REST bridge; the Flask endpoints are still there for that case.

`POST /api/broker-live/reset-sessions` drops the cached broker sessions if a
token goes stale mid-session.

## Reconciliation

After each sync, broker orders are linked back to algo executions by
`broker_order_id` / `exit_broker_order_id`, everything unmatched is tagged
`manual`, and four checks are recorded:

| Issue | Severity | Meaning |
|---|---|---|
| `execution_missing_at_broker` | error | the algo recorded a broker order the broker has no record of |
| `broker_rejected_but_execution_open` | error | the broker rejected an order the algo still treats as placed |
| `fill_price_mismatch` | warning | algo and broker disagree on the fill by more than 0.5% |
| `manual_open_position` | info | live exposure the algo did not open |

Issues not re-observed on the next pass are closed automatically.

## Windows Command Prompt

`env.cmd` (gitignored) holds the interpreter, the `ICT_AUTOMATION_ROOT` and the
Postgres connection, mirroring `scripts\start-rest-api.ps1` so the sync and the
REST API always hit the same database.

```bat
cd C:\Users\saite\OneDrive\Documents\Algo_ICT_Trader\scripts\broker_sync
call env.cmd

"%BROKER_SYNC_PYTHON%" selftest.py
"%BROKER_SYNC_PYTHON%" sync_broker_accounts.py --schema-only
"%BROKER_SYNC_PYTHON%" sync_broker_accounts.py --dry-run
"%BROKER_SYNC_PYTHON%" sync_broker_accounts.py
```

`run_daily_sync.cmd` wraps all of that with logging and is what Task Scheduler
should call:

```bat
schtasks /Create /TN "Titania Broker Sync" /SC WEEKLY /D MON,TUE,WED,THU,FRI ^
  /ST 16:15 /TR "C:\Users\saite\OneDrive\Documents\Algo_ICT_Trader\scripts\broker_sync\run_daily_sync.cmd"
```

The Windows interpreter needs the broker SDKs, which until now only lived in the
WSL venv:

```bat
"%BROKER_SYNC_PYTHON%" -m pip install smartapi-python growwapi pyotp
```

`pandas`, `requests` and `psycopg2` are already present in that Anaconda
environment because `backend\rest_api.py` runs on it.
