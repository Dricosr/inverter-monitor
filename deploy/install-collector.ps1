$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$TaskName = 'InverterMonitorCollector'
$Python = (Get-Command python.exe -ErrorAction Stop).Source
$User = "$env:USERDOMAIN\$env:USERNAME"
$PowerShell = (Get-Command pwsh.exe -ErrorAction SilentlyContinue)?.Source
if (-not $PowerShell) { $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source }

$command = "& { Set-Location '$Repo'; & '$Python' 'inverter_monitor.py' '--interval' '15' '--http' '8080' }"
$action = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$command`""
$atStartup = New-ScheduledTaskTrigger -AtStartup
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$settings.Hidden = $true

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atStartup, $atLogon) -Principal $principal -Settings $settings
Start-ScheduledTask -TaskName $TaskName

$rule = Get-NetFirewallRule -DisplayName 'InverterMonitorAPI 8080' -ErrorAction SilentlyContinue
if (-not $rule) {
    New-NetFirewallRule -DisplayName 'InverterMonitorAPI 8080' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow | Out-Null
}

# --- Vigia: o Agendador nao reinicia tarefa que morre com codigo 0 ---------------
$watchdogName = 'InverterMonitorWatchdog'
$watchdog = New-ScheduledTaskAction -Execute $PowerShell -Argument (
    "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass " +
    "-File `"$Repo\scripts\watchdog.ps1`"")
$everyTwoMinutes = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 2)
$watchdogSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$watchdogSettings.Hidden = $true

$existingWatchdog = Get-ScheduledTask -TaskName $watchdogName -ErrorAction SilentlyContinue
if ($existingWatchdog) { Unregister-ScheduledTask -TaskName $watchdogName -Confirm:$false }

Register-ScheduledTask -TaskName $watchdogName -Action $watchdog -Trigger $everyTwoMinutes `
    -Principal $principal -Settings $watchdogSettings `
    -Description 'Reinicia o coletor se a porta 8080 cair ou o snapshot parar de atualizar'
Start-ScheduledTask -TaskName $watchdogName
