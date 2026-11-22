# Explicit opt-in only. Run this file yourself after setup and dry-run verification.
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'agent.config.json'),
  [string]$TaskName = 'Remote PDF Print Agent'
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
& $node -e 'if(Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22 or newer is required.' }
$config = (Resolve-Path -LiteralPath $ConfigPath).Path
$agent = Join-Path $PSScriptRoot 'agent.mjs'
if ($config.Contains('"') -or $agent.Contains('"')) { throw 'Unsupported quote in path.' }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
# Validate JSON locally. No server calls, printer calls, or task execution here.
$data = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
if (-not $data.tokenFile -and -not [Environment]::GetEnvironmentVariable('REMOTE_PRINT_TOKEN', 'User')) {
  throw 'Startup requires a private tokenFile or persistent user REMOTE_PRINT_TOKEN. A session-only variable will not survive logon.'
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  throw 'Task already exists. Inspect/remove it explicitly before installing a replacement.'
}
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $agent + '" "' + $config + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host 'Registered for this user at next logon; not started now. No SYSTEM service. Physical output: NOT_OBSERVED.'
