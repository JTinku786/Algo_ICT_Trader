$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$Config = Join-Path $Root "cloudflared\config.yml"

if (-not (Test-Path $Config)) {
  throw "Missing $Config. Create a named tunnel first, then write config.yml from cloudflared\config.example.yml."
}

& $Cloudflared tunnel --config $Config run
