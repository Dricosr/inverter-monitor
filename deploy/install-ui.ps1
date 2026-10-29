$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$TaskName = 'InverterMonitorUI'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$User = "$env:USERDOMAIN\$env:USERNAME"
$PowerShell = (Get-Command pwsh.exe -ErrorAction SilentlyContinue)?.Source
if (-not $PowerShell) { $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source }

$command = "& { Set-Location '$Repo'; & '$Node' 'src/server.mjs' }"
$action = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$command`""
$atStartup = New-ScheduledTaskTrigger -AtStartup
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$settings.Hidden = $true

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atStartup, $atLogon) -Principal $principal -Settings $settings
Start-ScheduledTask -TaskName $TaskName

$rule = Get-NetFirewallRule -DisplayName 'InverterMonitorUI 3071' -ErrorAction SilentlyContinue
if (-not $rule) {
    New-NetFirewallRule -DisplayName 'InverterMonitorUI 3071' -Direction Inbound -Protocol TCP -LocalPort 3071 -Action Allow | Out-Null
}
