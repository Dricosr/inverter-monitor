# Reinicia o coletor quando ele morre ou para de atualizar o snapshot.
#
# Roda pelo Agendador de Tarefas a cada 2 minutos. Dois sintomas, um tratamento:
#   * porta 8080 nao responde  -> o processo morreu (inclusive com codigo 0, que o
#     "reiniciar em caso de falha" da tarefa nao cobre);
#   * snapshot parado          -> o processo vive mas travou num ciclo (dongle mudo).
#
# Nunca mexe na UI (porta 3071) e nao reinicia um coletor saudavel.
param(
    [int]$Port = 8080,
    [int]$MaxAgeSeconds = 180,
    [string]$TaskName = 'InverterMonitorCollector'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$snapshot = Join-Path $root 'data\latest.json'
$logFile = Join-Path $root 'data\watchdog.log'

function Write-Log([string]$Message, [string]$Level = 'INFO') {
    $line = '{0} {1,-7} {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 } catch { }
}

function Get-SnapshotAgeSeconds {
    if (-not (Test-Path -LiteralPath $snapshot)) { return $null }
    return ((Get-Date) - (Get-Item -LiteralPath $snapshot).LastWriteTime).TotalSeconds
}

function Test-CollectorListening {
    # Get-NetTCPConnection ja falha sozinho quando ninguem escuta
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    return [bool]$conn
}

try {
    # Tarefa registrada como "Interactive" roda na sessao do usuario e a janela do
    # console aparece na tela; com LogonType S4U ela roda na sessao 0 e nao aparece.
    # Avisar uma vez evita a duvida de "quem abriu essa janela do pwsh".
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

    $age = Get-SnapshotAgeSeconds
    $listening = Test-CollectorListening

    if ($listening -and $null -ne $age -and $age -le $MaxAgeSeconds) {
        exit 0   # saudavel: silencio (o log so registra o que deu errado)
    }

    if (-not $listening) {
        Write-Log "coletor nao responde na porta $Port - reiniciando" 'WARN'
    } else {
        $show = if ($null -eq $age) { 'sem snapshot' } else { '{0:N0}s de atraso' -f $age }
        Write-Log "coletor vivo mas parado ($show) - reiniciando" 'WARN'
    }

    # Encerra processo orfao (se houver) para liberar a porta 8899 do dongle.
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -like '*inverter_monitor.py*' } |
        ForEach-Object {
            Write-Log "encerrando pid $($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 12

    if (Test-CollectorListening) {
        Write-Log "coletor reiniciado e escutando na porta $Port"
        exit 0
    }
    Write-Log "coletor NAO voltou apos reiniciar - veja data\collector.log" 'ERROR'
    exit 1
} catch {
    Write-Log "falha no watchdog: $($_.Exception.Message)" 'ERROR'
    exit 1
}
