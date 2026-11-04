#!/usr/bin/env bash
#
# Daily broker-truth sync — WSL/Ubuntu cron runner.
#
# Fires at 16:30 IST on trading days and writes that day's orders, fills,
# positions and funds for every configured broker account.
#
# Why the schedule is expressed twice in the crontab
# --------------------------------------------------
# The crontab runs in America/New_York, and 16:30 IST is 07:00 ET under EDT but
# 06:00 ET under EST. Adding `CRON_TZ=Asia/Kolkata` would silently retime every
# job listed after it, so instead cron fires at BOTH 06:00 and 07:00 ET and this
# script decides. It runs when the India clock says 16:00 or later and today has
# not already been synced; otherwise it exits 0 having done nothing. That is
# DST-proof and cannot double-run.
#
# Exit codes:  0 success or deliberate skip, 1 at least one dataset failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${BROKER_SYNC_LOG_DIR:-$HERE/logs}"
STATE_DIR="$LOG_DIR/state"
mkdir -p "$LOG_DIR" "$STATE_DIR"

# Earliest India-clock minute at which the day is considered closed and final.
EARLIEST_IST_MINUTE="${BROKER_SYNC_EARLIEST_IST_MINUTE:-960}"   # 16:00 IST

IST_DATE="$(TZ=Asia/Kolkata date +%F)"
IST_TIME="$(TZ=Asia/Kolkata date +%H:%M)"
IST_MINUTE=$(( 10#$(TZ=Asia/Kolkata date +%H) * 60 + 10#$(TZ=Asia/Kolkata date +%M) ))
MARKER="$STATE_DIR/synced_$IST_DATE.ok"

DATED_LOG="$LOG_DIR/broker_sync_$IST_DATE.log"
SUMMARY="$LOG_DIR/broker_sync_latest.json"
HISTORY="$LOG_DIR/broker_sync_runs.jsonl"
STATUS="$LOG_DIR/broker_sync_status.json"

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$DATED_LOG"; }

# --- decide whether this invocation is the real one -------------------------
if [[ -f "$MARKER" ]]; then
  log "SKIP: already completed for IST date $IST_DATE — day marker present: $MARKER"
  exit 0
fi
if (( IST_MINUTE < EARLIEST_IST_MINUTE )); then
  log "SKIP: too early — India clock is $IST_TIME IST, waiting for 16:00 IST"
  exit 0
fi

# --- interpreter and environment -------------------------------------------
# The trading venv already carries SmartApi, growwapi, pyotp and psycopg2.
PY="${BROKER_SYNC_PYTHON:-/mnt/c/Users/saite/Desktop/Titannia-Cronjob-scripts/myenv/bin/python}"
if [[ ! -x "$PY" ]]; then
  PY="$(command -v python3 || true)"
fi
if [[ -z "$PY" ]]; then
  log "FATAL: no usable python interpreter found"
  exit 1
fi

export ICT_AUTOMATION_ROOT="${ICT_AUTOMATION_ROOT:-/mnt/c/Users/saite/Desktop/ICT_Automation}"

# --- Postgres -----------------------------------------------------------------
# Postgres runs natively on Windows, so from WSL the host is the Windows side of
# the NAT bridge, not localhost. That gateway address CHANGES when WSL restarts,
# which is exactly why Cron_Monitoring_Streamlit auto-detects it rather than
# hardcoding it — do the same here instead of pinning 172.26.224.1.
CRONMON_ENV="/mnt/c/Users/saite/Desktop/Cron_Monitoring_Streamlit/config/db.env"
if [[ -z "${PGPASSWORD:-}" && -f "$CRONMON_ENV" ]]; then
  # shellcheck disable=SC1091
  set -a; . "$CRONMON_ENV"; set +a
fi

# Only RFC1918 addresses can be the WSL side of the NAT bridge. Anything else
# means detection latched onto a public DNS server, which must never become
# PGHOST.
is_private_ipv4() {
  local ip="$1"
  [[ "$ip" =~ ^10\. ]] && return 0
  [[ "$ip" =~ ^192\.168\. ]] && return 0
  [[ "$ip" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] && return 0
  return 1
}

detect_windows_host() {
  local ip_bin gateway nameserver
  # cron runs with PATH=/usr/bin:/bin, but `ip` lives in /usr/sbin or /sbin, so
  # it has to be located explicitly or this silently finds nothing.
  for ip_bin in /usr/sbin/ip /sbin/ip /bin/ip /usr/bin/ip "$(command -v ip 2>/dev/null || true)"; do
    [[ -x "$ip_bin" ]] || continue
    gateway="$("$ip_bin" route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
    if [[ -n "$gateway" ]] && is_private_ipv4 "$gateway"; then
      printf '%s|default-route' "$gateway"
      return
    fi
    break
  done
  # WSL publishes the Windows host in resolv.conf only when generateResolvConf
  # is on; with custom DNS this is a public resolver, hence the private check.
  nameserver="$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null)"
  if [[ -n "$nameserver" ]] && is_private_ipv4 "$nameserver"; then
    printf '%s|resolv.conf' "$nameserver"
    return
  fi
  printf '%s|fallback' "172.26.224.1"
}

if [[ -z "${PGHOST:-}" ]]; then
  detected="$(detect_windows_host)"
  PGHOST="${detected%%|*}"
  PGHOST_SOURCE="${detected##*|}"
else
  PGHOST_SOURCE="environment"
fi
export PGHOST
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-titania_trading}"
export PGUSER="${PGUSER:-postgres}"
export PGSSLMODE="${PGSSLMODE:-disable}"

if [[ -z "${PGPASSWORD:-}" ]]; then
  log "WARN: PGPASSWORD is unset and $CRONMON_ENV did not provide one; the sync will fail to connect"
fi

START_EPOCH="$(date +%s)"
log "START broker sync — IST $IST_DATE $IST_TIME — python $PY — postgres $PGUSER@$PGHOST:$PGPORT/$PGDATABASE (host via $PGHOST_SOURCE)"

"$PY" "$HERE/sync_broker_accounts.py" --json-out "$SUMMARY" "$@" >>"$DATED_LOG" 2>&1
RC=$?

END_EPOCH="$(date +%s)"
DURATION=$(( END_EPOCH - START_EPOCH ))

# --- machine-readable status for the monitoring dashboard -------------------
"$PY" - "$SUMMARY" "$STATUS" "$HISTORY" "$RC" "$DURATION" "$IST_DATE" <<'PYEOF' >>"$DATED_LOG" 2>&1
import json, sys, pathlib, datetime

summary_path, status_path, history_path, rc, duration, ist_date = sys.argv[1:7]
try:
    summary = json.loads(pathlib.Path(summary_path).read_text(encoding="utf-8"))
except Exception:
    summary = {}

accounts = summary.get("accounts") or []
datasets = [
    {"account": f"{a.get('broker')}/{a.get('account')}", "dataset": name, **stats}
    for a in accounts for name, stats in (a.get("datasets") or {}).items()
]
status = {
    "ist_date": ist_date,
    "finished_at": datetime.datetime.now().astimezone().isoformat(),
    "exit_code": int(rc),
    "duration_seconds": int(duration),
    "ok": int(rc) == 0,
    "accounts": len(accounts),
    "accounts_verified": sum(1 for a in accounts if a.get("auth_status") == "verified"),
    "rows_written": sum(int(d.get("written") or 0) for d in datasets),
    "datasets_failed": [d["account"] + ":" + d["dataset"] for d in datasets if d.get("status") == "failed"],
    "failures": summary.get("failures") or [],
    "degraded": summary.get("degraded") or [],
    "unsupported": [d["account"] + ":" + d["dataset"] for d in datasets if d.get("status") == "unsupported"],
}
pathlib.Path(status_path).write_text(json.dumps(status, indent=2), encoding="utf-8")
with pathlib.Path(history_path).open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(status) + "\n")
print(
    f"RESULT ok={status['ok']} rows_written={status['rows_written']} "
    f"accounts={status['accounts_verified']}/{status['accounts']} "
    f"failed={status['failures'] or 'none'} degraded={status['degraded'] or 'none'} "
    f"duration={duration}s"
)
PYEOF

if [[ $RC -eq 0 ]]; then
  : > "$MARKER"
  log "DONE broker sync succeeded in ${DURATION}s — day marker: $MARKER"
else
  log "FAILED broker sync exited $RC after ${DURATION}s — no marker, the next cron slot will retry"
fi

# Keep 60 days of dated logs and markers; the JSONL history is small and kept.
find "$LOG_DIR" -maxdepth 1 -name 'broker_sync_20*.log' -mtime +60 -delete 2>/dev/null || true
find "$STATE_DIR" -maxdepth 1 -name 'synced_*.ok' -mtime +60 -delete 2>/dev/null || true

exit $RC
