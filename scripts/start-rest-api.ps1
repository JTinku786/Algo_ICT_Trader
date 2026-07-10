$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Python = "C:\Users\saite\anaconda3\python.exe"
$Port = if ($env:PORT) { $env:PORT } else { "8765" }
$TokenFile = Join-Path $Root "backend\api-token.local"

if (-not (Test-Path $TokenFile)) {
  $Token = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
  Set-Content -LiteralPath $TokenFile -Value $Token
}

$env:ALGO_API_TOKEN = (Get-Content -Raw $TokenFile).Trim()
$env:POSTGRES_HOST = if ($env:POSTGRES_HOST) { $env:POSTGRES_HOST } else { "172.26.224.1" }
$env:POSTGRES_PORT = if ($env:POSTGRES_PORT) { $env:POSTGRES_PORT } else { "5432" }
$env:POSTGRES_DATABASE = if ($env:POSTGRES_DATABASE) { $env:POSTGRES_DATABASE } else { "titania_trading" }
$env:POSTGRES_USER = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "postgres" }
$env:POSTGRES_PASSWORD = if ($env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD } else { "REMOVED_USE_postgres-password.local" }
$env:POSTGRES_SSLMODE = if ($env:POSTGRES_SSLMODE) { $env:POSTGRES_SSLMODE } else { "disable" }

Set-Location (Join-Path $Root "backend")
& $Python serve.py
