param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 40)]
    [int]$Threads
)

$ErrorActionPreference = 'Stop'
$Base = 'D:\Monero\xmrig'
$ThreadsFile = Join-Path $Base 'automation-threads.txt'
$TaskName = 'MoneroMining'
$pattern = [regex]::Escape("--threads=$Threads") + '(\s|$)'

function Get-Miner {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'xmrig.exe' -and $_.CommandLine -like "*$Base*" }
}

$live = Get-Miner
$matching = $live | Where-Object { $_.CommandLine -match $pattern }
if ($matching) {
    Set-Content -Path $ThreadsFile -Value $Threads -NoNewline
    Write-Output 'changed=false verified=true'
    exit 0
}

Set-Content -Path $ThreadsFile -Value $Threads -NoNewline

Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-Miner)) { break }
    Start-Sleep -Milliseconds 500
}

foreach ($process in (Get-Miner)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop

$verified = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-Miner | Where-Object { $_.CommandLine -match $pattern }) { $verified = $true; break }
}

Write-Output ("changed=true verified={0}" -f $verified.ToString().ToLower())
if (-not $verified) { exit 1 }
