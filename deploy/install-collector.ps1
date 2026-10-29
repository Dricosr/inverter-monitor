$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$TaskName = 'InverterMonitorCollector'
$Python = (Get-Command python.exe -ErrorAction Stop).Source
$User = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute $Python -Argument 'inverter_monitor.py --interval 15 --http 8080' -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Start-ScheduledTask -TaskName $TaskName

$rule = Get-NetFirewallRule -DisplayName 'InverterMonitorAPI 8080' -ErrorAction SilentlyContinue
if (-not $rule) {
    New-NetFirewallRule -DisplayName 'InverterMonitorAPI 8080' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow | Out-Null
}
