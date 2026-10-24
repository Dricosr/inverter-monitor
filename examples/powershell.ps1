<#
    Exemplo: consulta a API do inverter-monitor e mostra um resumo.

    Por padrao apenas LE e imprime (nao aciona nada).
    Descomente o bloco final para agir sobre equipamentos.

    Uso:
        .\powershell.ps1
        .\powershell.ps1 -BaseUrl http://192.168.18.131:8080
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://localhost:8080'
)

try {
    $status = Invoke-RestMethod -Uri "$BaseUrl/status" -TimeoutSec 10
}
catch {
    Write-Error "Nao consegui falar com $BaseUrl/status. O servico esta rodando? $($_.Exception.Message)"
    exit 1
}

$linhas = foreach ($nome in $status.devices.PSObject.Properties.Name) {
    $d = $status.devices.$nome
    if (-not $d.online) {
        Write-Warning "$nome offline: $($d.error)"
        continue
    }

    [pscustomobject]@{
        Inversor    = $nome
        Protocolo   = $d.protocol
        Modo        = $d.mode
        'SOC (%)'   = $d.battery.soc
        'Bat (V)'   = $d.battery.voltage
        'Saida (W)' = $d.output.active_power
        'Carga (%)' = $d.load_percent
        'Ligar?'    = $d.automation.should_run
    }
}

$linhas | Format-Table -AutoSize

# ---------------------------------------------------------------------------
# Acionamento (descomente e adapte ao seu hardware):
#
# $alvo = $status.devices.'inversor-106'
# $ligar = $alvo.automation.should_run
# Invoke-RestMethod "http://192.168.18.50/relay?state=$(if ($ligar) { 'on' } else { 'off' })"
