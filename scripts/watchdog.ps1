# Mantem coletor e painel vivos, rodando o codigo que esta no disco.
#
# Roda pelo Agendador de Tarefas a cada 2 minutos, elevado (S4U). Tres sintomas, um
# tratamento por alvo:
#   * porta nao responde        -> o processo morreu (inclusive com codigo 0, que o
#                                  "reiniciar em caso de falha" da tarefa nao cobre);
#   * snapshot parado           -> o coletor vive mas travou num ciclo (dongle mudo);
#   * codigo mais novo no disco -> o processo em memoria e anterior ao commit atual
#                                  (foi assim que o painel passou dias com codigo velho,
#                                  mesmo com a tarefa "Running").
#
# `Stop-ScheduledTask` nao mata o processo filho: se o node/python ficar orfao segurando
# a porta, ele e encerrado pelo PID dono da porta antes de subir a nova instancia.
param(
    [int]$CollectorPort = 8080,
    [int]$UiPort = 3071,
    [int]$MaxAgeSeconds = 180,
    [string]$CollectorTask = 'InverterMonitorCollector',
    [string]$UiTask = 'InverterMonitorUI'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$snapshot = Join-Path $root 'data\latest.json'
$logFile = Join-Path $root 'data\watchdog.log'

function Write-Log([string]$Message, [string]$Level = 'INFO') {
    $line = '{0} {1,-7} {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 } catch { }
}

function Test-Listening([int]$Port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Get-PortOwner([int]$Port) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($conn) { return [int]$conn.OwningProcess }
    return $null
}

function Get-SnapshotAgeSeconds {
    if (-not (Test-Path -LiteralPath $snapshot)) { return $null }
    return ((Get-Date) - (Get-Item -LiteralPath $snapshot).LastWriteTime).TotalSeconds
}

# Instante do arquivo mais novo entre os codigos que o processo carrega.
function Get-CodeStamp([string[]]$Patterns) {
    $newest = $null
    foreach ($pattern in $Patterns) {
        Get-ChildItem -Path (Join-Path $root $pattern) -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notlike '*node_modules*' } |
            ForEach-Object {
                if (-not $newest -or $_.LastWriteTimeUtc -gt $newest) { $newest = $_.LastWriteTimeUtc }
            }
    }
    return $newest
}

function Restart-Target {
    param(
        [string]$Label,
        [int]$Port,
        [string]$TaskName,
        [int]$WaitSeconds = 15
    )

    $owner = Get-PortOwner $Port
    if ($owner) {
        Write-Log "encerrando $Label orfao (pid $owner) que segurava a porta $Port"
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds $WaitSeconds

    if (Test-Listening $Port) {
        Write-Log "$Label reiniciado e escutando na porta $Port"
        return $true
    }
    Write-Log "$Label NAO voltou apos reiniciar - veja data\collector.log" 'ERROR'
    return $false
}

try {
    # Tarefa registrada como "Interactive" roda na sessao do usuario e a janela do
    # console aparece na tela; com LogonType S4U ela roda na sessao 0 e nao aparece.
    $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($session -ne 0) {
        $tail = @()
        if (Test-Path -LiteralPath $logFile) {
            $tail = Get-Content -LiteralPath $logFile -Tail 30 -ErrorAction SilentlyContinue
        }
        if (-not ($tail | Where-Object { $_ -like '*janela do console*' })) {
            Write-Log ("tarefa na sessao $session (interativa): a janela do console do pwsh fica visivel. " +
                "Re-registre com -Principal -LogonType S4U para ela desaparecer") 'WARN'
        }
    }

    $failed = $false

    # ------------------------------------------------------------------ coletor
    $age = Get-SnapshotAgeSeconds
    $collectorUp = Test-Listening $CollectorPort
    if (-not ($collectorUp -and $null -ne $age -and $age -le $MaxAgeSeconds)) {
        if (-not $collectorUp) {
            Write-Log "coletor nao responde na porta $CollectorPort - reiniciando" 'WARN'
        } else {
            $show = if ($null -eq $age) { 'sem snapshot' } else { '{0:N0}s de atraso' -f $age }
            Write-Log "coletor vivo mas parado ($show) - reiniciando" 'WARN'
        }
        if (-not (Restart-Target -Label 'coletor' -Port $CollectorPort -TaskName $CollectorTask)) {
            $failed = $true
        }
    }

    # -------------------------------------------------------------------- painel
    if (Test-Listening $UiPort) {
        # Painel de pe, mas carregado de uma versao anterior do codigo.
        $code = Get-CodeStamp @('src', 'public', 'package.json')
        $owner = Get-PortOwner $UiPort
        $started = (Get-Process -Id $owner -ErrorAction SilentlyContinue).StartTime
        if ($code -and $started -and $code -gt $started.ToUniversalTime()) {
            Write-Log ("painel rodando codigo anterior ao do disco (processo de " +
                "$($started.ToString('yyyy-MM-dd HH:mm')), codigo de " +
                "$($code.ToString('yyyy-MM-dd HH:mm'))) - reiniciando") 'WARN'
            if (-not (Restart-Target -Label 'painel' -Port $UiPort -TaskName $UiTask -WaitSeconds 25)) {
                $failed = $true
            }
        }
    } else {
        Write-Log "painel nao responde na porta $UiPort - reiniciando" 'WARN'
        if (-not (Restart-Target -Label 'painel' -Port $UiPort -TaskName $UiTask -WaitSeconds 25)) {
            $failed = $true
        }
    }

    if ($failed) { exit 1 }
    exit 0
} catch {
    Write-Log "falha no watchdog: $($_.Exception.Message)" 'ERROR'
    exit 1
}
