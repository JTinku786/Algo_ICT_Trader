# Keeps Windows from sleeping for N hours (default 24) so the bridge + zrok stay reachable.
# Temporary: uses SetThreadExecutionState, which ends when this script exits. No power settings change.
param([double]$Hours = 24)
Add-Type -Namespace Titania -Name Power -MemberDefinition @"
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
"@
$ES_CONTINUOUS = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Log = Join-Path $Root "logs\bridge-keepalive.log"
$until = (Get-Date).AddHours($Hours)
Add-Content $Log ("{0}  keep-awake on until {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $until.ToString("yyyy-MM-dd HH:mm"))
while ((Get-Date) -lt $until) {
  [Titania.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
  Start-Sleep 60
}
[Titania.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
Add-Content $Log ("{0}  keep-awake ended" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
