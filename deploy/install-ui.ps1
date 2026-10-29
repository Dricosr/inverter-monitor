$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$TaskName = 'InverterMonitorUI'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$User = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute $Node -Argument 'src/server.mjs' -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Start-ScheduledTask -TaskName $TaskName

$rule = Get-NetFirewallRule -DisplayName 'InverterMonitorUI 3071' -ErrorAction SilentlyContinue
if (-not $rule) {
    New-NetFirewallRule -DisplayName 'InverterMonitorUI 3071' -Direction Inbound -Protocol TCP -LocalPort 3071 -Action Allow | Out-Null
}
