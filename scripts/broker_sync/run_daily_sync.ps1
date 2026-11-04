<#
.SYNOPSIS
  Daily broker-truth sync (Windows Task Scheduler wrapper).

.DESCRIPTION
  Register a 16:15 IST weekday run with:

    schtasks /Create /TN "Titania Broker Sync" /SC WEEKLY /D MON,TUE,WED,THU,FRI `
      /ST 16:15 /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\saite\OneDrive\Documents\Algo_ICT_Trader\scripts\broker_sync\run_daily_sync.ps1"

  Adjust /ST to your machine's local time if it is not set to IST.
#>
param([string[]]$SyncArgs = @())

$ErrorActionPreference = "Continue"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = if ($env:BROKER_SYNC_LOG_DIR) { $env:BROKER_SYNC_LOG_DIR } else { Join-Path $Here "logs" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Python = if ($env:BROKER_SYNC_PYTHON) { $env:BROKER_SYNC_PYTHON } else { "python" }
if (-not $env:ICT_AUTOMATION_ROOT) {
    $env:ICT_AUTOMATION_ROOT = "C:\Users\saite\Desktop\ICT_Automation"
}

$Stamp = Get-Date -Format "yyyy-MM-dd"
$Log = Join-Path $LogDir "broker_sync_$Stamp.log"
$Summary = Join-Path $LogDir "broker_sync_latest.json"

"=== broker sync started $(Get-Date -Format o) ===" | Out-File -Append -FilePath $Log
& $Python (Join-Path $Here "sync_broker_accounts.py") --json-out $Summary @SyncArgs *>&1 | Out-File -Append -FilePath $Log
$Code = $LASTEXITCODE
"=== broker sync finished $(Get-Date -Format o) exit=$Code ===" | Out-File -Append -FilePath $Log
exit $Code
