#!/usr/bin/env bash
#
# Install (or refresh) the broker-truth sync in the WSL Ubuntu crontab.
#
# Idempotent: re-running replaces the block rather than adding a second copy.
# Backs the existing crontab up first, and prints a diff before installing.
#
#   bash install_cron.sh            # show what would change, install after confirming
#   bash install_cron.sh --yes      # install without the prompt
#   bash install_cron.sh --remove   # take the block back out
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/broker_truth_sync_india.sh"
LOG_DIR="${BROKER_SYNC_LOG_DIR:-$HERE/logs}"
CRON_LOG="$LOG_DIR/broker_sync_cron.log"
MARKER_BEGIN="# >>> broker-truth sync (managed) >>>"
MARKER_END="# <<< broker-truth sync (managed) <<<"

ASSUME_YES=0
REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --remove) REMOVE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$RUNNER" ]]; then
  echo "runner not found: $RUNNER" >&2
  exit 1
fi
chmod +x "$RUNNER" 2>/dev/null || true
mkdir -p "$LOG_DIR"

BLOCK="$MARKER_BEGIN
# Angel One / Dhan / Groww -> realtime_production_broker_* tables.
#
# Target is 16:30 IST on India trading days. This crontab is evaluated in
# America/New_York, where 16:30 IST is 07:00 ET under EDT and 06:00 ET under
# EST. Setting CRON_TZ here would retime every job listed after it, so instead
# all four slots fire and broker_truth_sync_india.sh decides: it runs once the
# India clock reads 16:00 or later and today has not already been synced, and
# exits 0 doing nothing otherwise. 09:00 and 11:00 ET are retry slots for a day
# where the broker or the network was down at the first attempt.
0 6,7,9,11 * * 1-5 /bin/bash $RUNNER >> $CRON_LOG 2>&1
$MARKER_END"

CURRENT="$(crontab -l 2>/dev/null || true)"
STRIPPED="$(printf '%s\n' "$CURRENT" | awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  !skip   { print }
')"

if [[ $REMOVE -eq 1 ]]; then
  PROPOSED="$STRIPPED"
else
  # Keep the block last so it can never affect anything above it.
  PROPOSED="$(printf '%s\n%s\n' "${STRIPPED%$'\n'}" "$BLOCK")"
fi

BACKUP="$LOG_DIR/crontab.backup.$(date +%Y%m%d-%H%M%S).txt"
# Second resolution alone lets two runs in the same second overwrite one
# another, which would quietly destroy the only copy of the previous crontab.
SUFFIX=1
while [[ -e "$BACKUP" ]]; do
  BACKUP="$LOG_DIR/crontab.backup.$(date +%Y%m%d-%H%M%S).$SUFFIX.txt"
  SUFFIX=$(( SUFFIX + 1 ))
done
printf '%s\n' "$CURRENT" > "$BACKUP"

echo "Current crontab backed up to: $BACKUP"
echo
echo "--- proposed change ---"
if command -v diff >/dev/null 2>&1; then
  diff <(printf '%s\n' "$CURRENT") <(printf '%s\n' "$PROPOSED") || true
else
  printf '%s\n' "$PROPOSED"
fi
echo "-----------------------"
echo

if [[ $ASSUME_YES -ne 1 ]]; then
  read -r -p "Install this crontab? [y/N] " reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Aborted. Nothing changed."; exit 0 ;;
  esac
fi

printf '%s\n' "$PROPOSED" | crontab -
echo "Installed. Verifying:"
crontab -l | grep -n "broker_truth_sync_india" || echo "  (block not found — check the output above)"
echo
echo "Next: refresh the monitoring registry so the dashboard picks the job up."
echo "  cd /mnt/c/Users/saite/Desktop/Cron_Monitoring_Streamlit"
echo "  ~/.venvs/cronmon/bin/python scripts/generate_registry.py"
