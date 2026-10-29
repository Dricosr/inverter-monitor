param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 40)]
    [int]$Threads
)

$ErrorActionPreference = 'Stop'
$Base = 'D:\Monero\xmrig'
$ThreadsFile = Join-Path $Base 'automation-threads.txt'
$TaskName = 'MoneroMining'

$live = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'xmrig.exe' -and $_.CommandLine -like "*$Base*" }
$expected = "--threads=$Threads"
$matching = $live | Where-Object { $_.CommandLine -like "*$expected*" }
if ($matching) {
    Set-Content -Path $ThreadsFile -Value $Threads -NoNewline
    Write-Output "changed=false"
    exit 0
}

Set-Content -Path $ThreadsFile -Value $Threads -NoNewline

Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
for ($i = 0; $i -lt 15; $i++) {
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'xmrig.exe' -and $_.CommandLine -like "*$Base*" }
    if (-not $processes) { break }
    Start-Sleep -Milliseconds 500
}

$remaining = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'xmrig.exe' -and $_.CommandLine -like "*$Base*" }
foreach ($process in $remaining) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Output "changed=true"
