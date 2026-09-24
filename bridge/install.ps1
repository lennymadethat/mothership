# Mothership Bridge installer — run from the bridge folder.
#   .\install.ps1 -HubUrl https://mothership-hub.YOUR_SUBDOMAIN.workers.dev -Machine my-desktop
# -Token is required: the hub answers nothing without HUB_TOKEN, so the bridge needs the same value.
param(
  [Parameter(Mandatory=$true)][string]$HubUrl,
  [Parameter(Mandatory=$true)][string]$Machine,
  [Parameter(Mandatory=$true)][string]$Token,
  [switch]$NoTask
)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

Write-Host "[1/4] npm install..." -ForegroundColor Cyan
npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Write-Host "[2/4] writing config.json..." -ForegroundColor Cyan
$cfg = @{ hubUrl = $HubUrl.TrimEnd('/'); machine = $Machine.ToLower(); token = $Token } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $dir 'config.json'), $cfg, (New-Object System.Text.UTF8Encoding $false))
New-Item -ItemType Directory -Force (Join-Path $dir 'data') | Out-Null

if (-not $NoTask) {
  Write-Host "[3/4] registering scheduled task (auto-start at boot AND logon)..." -ForegroundColor Cyan
  $vbs = Join-Path $dir 'run-hidden.vbs'
  try { Unregister-ScheduledTask -TaskName 'MothershipBridge' -Confirm:$false -ErrorAction Stop } catch {}
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $dir
  # AtStartup + S4U principal: the bridge comes back after an unattended reboot
  # (Windows Update at 3am) with nobody logged in — no stored password needed.
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'MothershipBridge' -Action $action -Trigger $triggers -Principal $principal -Settings $settings | Out-Null
  Write-Host "[4/4] starting bridge now..." -ForegroundColor Cyan
  Start-ScheduledTask -TaskName 'MothershipBridge'
} else {
  Write-Host "[3/4] skipping scheduled task (-NoTask). Start manually: node bridge.js" -ForegroundColor Yellow
}

Start-Sleep -Seconds 3
$log = Join-Path $dir 'data\bridge.log'
if (Test-Path $log) { Write-Host "--- bridge.log tail ---"; Get-Content $log -Tail 5 }
Write-Host "`nDone. Machine '$Machine' should appear online in the Mothership PWA." -ForegroundColor Green
