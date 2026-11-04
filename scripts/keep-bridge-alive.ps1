# Keeps the Vercel data path up: REST bridge (127.0.0.1:8765) + zrok share (algoicttraderapi).
# Checks every 30 s and restarts whatever is down. One copy runs at a time (named mutex).
# Started by the scheduled task "Titania Bridge KeepAlive" (at logon + every 5 min as a backup).

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Scripts = Join-Path $Root "scripts"
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$Log = Join-Path $LogDir "bridge-keepalive.log"
$PublicHealth = "https://algoicttraderapi.share.zrok.io/health"

$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\TitaniaBridgeKeepAlive", [ref]$created)
if (-not $created) { exit 0 }   # already running

function Write-Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -LiteralPath $Log -Value $line
  if ((Get-Item -LiteralPath $Log).Length -gt 2MB) {
    Move-Item -LiteralPath $Log -Destination "$Log.old" -Force
  }
}

function Test-Url($url, $timeout = 8) {
  try { return (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec $timeout).StatusCode -eq 200 } catch { return $false }
}

function Start-Hidden($file, $name) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$file`"" `
    -RedirectStandardOutput (Join-Path $LogDir "$name.out.log") -RedirectStandardError (Join-Path $LogDir "$name.err.log") | Out-Null
}

function Restart-Bridge {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'serve\.py' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 2
  Start-Hidden (Join-Path $Scripts "start-rest-api.ps1") "rest-api"
}

function Restart-Zrok {
  Get-Process zrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
  Start-Hidden (Join-Path $Scripts "start-zrok-share.ps1") "zrok"
}

Write-Log "keep-alive started (pid $PID)"
$publicFails = 0
while ($true) {
  if (-not (Test-Url "http://127.0.0.1:8765/health" 5)) {
    Start-Sleep 5
    if (-not (Test-Url "http://127.0.0.1:8765/health" 5)) {
      Write-Log "bridge down -> restarting"
      Restart-Bridge
      Start-Sleep 15
    }
  }
  if (-not (Get-Process zrok -ErrorAction SilentlyContinue)) {
    Write-Log "zrok not running -> starting"
    Start-Hidden (Join-Path $Scripts "start-zrok-share.ps1") "zrok"
    Start-Sleep 15
    $publicFails = 0
  } elseif (-not (Test-Url $PublicHealth 15)) {
    $publicFails++
    if ($publicFails -ge 3) {
      Write-Log "public URL failing 3x -> restarting zrok"
      Restart-Zrok
      Start-Sleep 15
      $publicFails = 0
    }
  } else {
    $publicFails = 0
  }
  Start-Sleep 30
}
