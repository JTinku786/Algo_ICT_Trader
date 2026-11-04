# Pre-computes SMT divergence for every Realtime and Backtest trade (cached in ict_trade_smt).
# Safe to re-run: cached trades are skipped. Progress -> tmp\smt_backfill.log
#   powershell -ExecutionPolicy Bypass -File scripts\smt_backfill.ps1
$ErrorActionPreference = "Continue"
$base = "http://localhost:3000"
$log = Join-Path $PSScriptRoot "..\tmp\smt_backfill.log"
function Log($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 $log }
Log "=== SMT backfill start ==="

# Realtime: every strategy, every market.
$rt = "market=ALL&strategy=ALL&ticker=ALL&ict_session=ALL&planned_rr=ALL&direction=ALL&status=ALL&source_mode=ALL&duplicates=INCLUDE&score_model=incumbent&page=1&page_size=10&smt_batch=500"
for ($i = 0; $i -lt 200; $i++) {
  try { $j = Invoke-RestMethod -TimeoutSec 600 "$base/api/realtime-analytics?$rt" } catch { Log "realtime error: $($_.Exception.Message)"; Start-Sleep 10; continue }
  $pending = ($j.smt_performance | Where-Object { $_.group -eq "Pending" } | Measure-Object -Property outcomes -Sum).Sum
  $rows = $j.counts.signals
  Log "realtime pass $i : signals=$rows pending(closed)=$pending"
  if (-not $pending) { break }
}

# Backtest: every strategy, all years.
$filters = Invoke-RestMethod -TimeoutSec 600 "$base/api/backtest?filters_only=true"
$strategies = @($filters.filters.strategies | ForEach-Object { if ($_.strategy_id) { $_.strategy_id } else { $_ } })
foreach ($s in $strategies) {
  for ($i = 0; $i -lt 400; $i++) {
    $q = "symbol=ALL&strategy_id=$([uri]::EscapeDataString($s))&direction=ALL&build=ALL&target_no=1&year=ALL&include_filters=false&smt_batch=1000"
    try { $j = Invoke-RestMethod -TimeoutSec 900 "$base/api/backtest?$q" } catch { Log "backtest $s error: $($_.Exception.Message)"; break }
    $c = $j.smt_coverage
    Log "backtest $s pass $i : $($c.computed)/$($c.total)"
    if (-not $c -or $c.computed -ge $c.total) { break }
  }
}
Log "=== SMT backfill done ==="
