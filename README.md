# ⚡ Monitor local dos inversores híbridos (LAN)

![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![Node.js](https://img.shields.io/badge/node.js-20%2B-5FA04E)
![Dependências](https://img.shields.io/badge/depend%C3%AAncias-nenhuma-brightgreen)
![Testes](https://img.shields.io/badge/testes-69%20passando-brightgreen)
![Licença](https://img.shields.io/badge/licen%C3%A7a-MIT-green)
![Plataforma](https://img.shields.io/badge/plataforma-windows%20%7C%20linux%20%7C%20macos-lightgrey)

Leitura **direta pela rede local**, sem nuvem, de inversores híbridos com dongle WiFi da
família **Eybond / DessMonitor** — a mesma dos apps *SmartESS*, *DESS Monitor* e
*Wi-Fi Pro*. Entrega SOC da bateria, tensões, correntes, potências, PV e temperaturas em
JSON, com API HTTP pronta para automação, além de um painel web que executa ações por SOC.

O coletor **não tem dependências externas** (só a biblioteca padrão do Python 3.10+); o
painel depende apenas de `express`.

```text
inversor-59    Off-Grid  SOC 62 %   52,7 V   PV 524 W  (MPPT1 203 · MPPT2 321)
inversor-106   Battery   SOC 48 %   53,1 V   saída 283 W · MPPT1 0 W · balanço DC ≥ 283 W
anenji-6k2     —         sem resposta (fora da LAN)
```

## Começando em dois comandos

```powershell
python inverter_monitor.py --interval 15 --http 8080   # coletor + API em :8080
npm install; npm start                                 # painel em http://127.0.0.1:3071
```

Para deixar os dois invisíveis e subindo com o sistema, use [`deploy/`](deploy) — veja
[Rodar como serviço](#rodar-como-serviço).

---

## Sumário

- [Por que existe](#por-que-existe)
- [Como funciona](#como-funciona)
- [Os três inversores](#os-três-inversores)
- [O que cada protocolo entrega](#o-que-cada-protocolo-entrega)
- [Painel web](#painel-web)
- [Automação por SOC](#automação-por-soc)
- [Quando um inversor fica offline](#quando-um-inversor-fica-offline)
- [Instalação](#instalação)
- [Linha de comando](#linha-de-comando)
- [API HTTP](#api-http)
- [Formato do JSON](#formato-do-json)
- [Integração com outros sistemas](#integração-com-outros-sistemas)
- [Rodar como serviço](#rodar-como-serviço)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Testes](#testes)
- [Solução de problemas](#solução-de-problemas)
- [Limitações e efeitos colaterais](#limitações-e-efeitos-colaterais)
- [Roadmap](#roadmap)
- [Referências](#referências)
- [Licença](#licença)

---

## Por que existe

Esses inversores só publicam dados na nuvem do fabricante. Não há documentação de API
local, e os projetos prontos ([`powmr-eybond-proxy`], [`anenji-local-modbus`],
`mpp-solar`…) assumem **um** modelo específico de inversor.

A abordagem aqui foi empírica: varrer a rede, descobrir que **nenhum** dos três dongles
expõe telemetria por TCP em repouso (o `.59` só tem uma página de configuração na porta
80), achar o gatilho UDP que os reverte para a LAN e, a partir daí, identificar **três
protocolos diferentes** atrás de dongles aparentemente iguais.

O objetivo prático era ler o SOC da bateria para decidir quando ligar equipamentos do
escritório — sem depender de latência de nuvem nem de cota de API.

## Como funciona

```text
┌──────────────┐   1. UDP :58899  "set>server=<ip>:8899;"   ┌─────────────────┐
│  este PC     │ ─────────────────────────────────────────▶ │  dongle WiFi    │
│              │ ◀───────────────────────────────────────── │  (Eybond)       │
│  TCP :8899   │        2. "rsp>server=1;"                  │                 │
│  (servidor)  │                                            └────────┬────────┘
│              │ ◀──────── 3. o dongle conecta de volta ────────────┘
│              │                                                    │
│              │  4. frames Eybond  fc=4 (transparente)             ▼ RS485
│              │ ◀──────────────────────────────────────────▶ ┌─────────────┐
└──────────────┘   tid dev len addr fc payload               │  inversor   │
       │                                                     └─────────────┘
       ▼
  GET /status (HTTP)  ·  data/latest.json  ·  painel Node.js (:3071)
```

1. O dongle é convencido a trocar o servidor de destino por este PC (comando UDP).
2. Ele abre uma conexão TCP **para nós** na porta 8899 (fixa no firmware).
3. Nessa conexão trafegam frames no formato Eybond:

   ```text
   tid:u16   dev:u16   len:u16   addr:u8   fc:u8   payload
   (big-endian; len conta addr + fc + payload)
   ```

4. Com `fc=4` o payload é repassado **cru** ao inversor. É assim que lemos `QPIGS`
   (ASCII) ou frames Modbus RTU.

Detalhamento completo — armadilhas do CRC, significado dos `fc`, mapas de registradores e
a conferência contra a nuvem do fabricante — em **[docs/PROTOCOL.md](docs/PROTOCOL.md)**.

## Os três inversores

| Nome | IP | Dongle | Protocolo | Identificação |
| --- | --- | --- | --- | --- |
| `anenji-6k2` | 192.168.18.33 | Espressif | Modbus RTU — mapa **EG4 3000EHV** (200–244) | reg. 643 = **6200 W** nominal |
| `inversor-59` | 192.168.18.59 | Quectel | Modbus RTU — mapa **Anenji/Megarevo** | reg. 691 = **11000 W** nominal |
| `inversor-106` | 192.168.18.106 | Espressif | ASCII **PI30** (`QPIGS`/`QMOD`) | `QMN` = `VMII-NXPW5KW`, CPU `00152.02`, nominal 10 200 VA/W |

> O `.106` responde ao `QID` com `55355535553555`, que **não** é o serial real: o
> fabricante o identifica por `Q0045529822108191005` (PN `Q0045529822108`, obtido via
> `fc=1`). Não use o `QID` como chave.

Varredura de `192.168.18.0/24` (ping + ARP + TCP 1–65535 + UDP discovery): dez
dispositivos na rede, três deles os dongles. Outros equipamentos vistos, que **não** são
inversores: `.1` roteador Huawei, `.5` PC Gigabyte, `.41` e `.66` dispositivos Tuya,
`.150` DUX, `.200` BMC ASRock.

> Nenhum dongle expõe telemetria por TCP em repouso: o `.59` responde na porta 80 apenas
> com a UI de configuração do próprio dongle, e `.33`/`.106` não abrem porta alguma. É
> exatamente por isso que `nmap`, Modbus TCP e as integrações tradicionais falham.

## O que cada protocolo entrega

Este é o ponto mais importante do projeto: **o que não é medido não é inventado**. Cada
card do painel diz de qual entrada o número veio.

| Grandeza | `modbus_a` (.33) | `modbus_b` (.59) | `pi30` (.106) |
| --- | --- | --- | --- |
| SOC | ✅ | ✅ | ✅ |
| Tensão da bateria | ✅ | ✅ | ✅ |
| Corrente / potência da bateria | ✅ | ✅ | ⚠️ **parcial** |
| PV — tensão | ✅ | ✅ (2 MPPTs) | ✅ só MPPT1 |
| PV — potência | ✅ | ✅ **medida por MPPT** | ⚠️ só MPPT1 |
| Temperatura do inversor | ✅ | ✅ (reg 231) | ✅ |
| Temperatura do painel / módulo DC | ✅ DC | ✅ ambos | — |
| Rede (tensão/frequência) | ✅ | — | — |

### O caso do MPS 10.2 (`.106`)

Esse inversor tem **dois MPPTs** e o firmware **não implementa `QPIGS2`** (responde `NAK`;
idem `QPGS0/1`, `QET`, `QLT`, `QBE`, `QPIZ`, `QPIC`, `QPIGS3`). O `QPIGS` carrega apenas
o **MPPT1**, que está **sem painéis**. A geração real (~317 V, ~1083 W) está no MPPT2 e
**não sai por nenhum comando PI30 aceito**; o Modbus RTU também não responde nessa
unidade (slaves 0–32 testados, todos timeout).

Conferido contra o app do fabricante **no mesmo minuto**:

| Fonte | PV1 | PV2 | Total |
| --- | --- | --- | --- |
| `QPIGS` local | 41,7 V / 0 W | não exposto | — |
| App do fabricante | 41,7 V / 0 W | 317,5 V / **1083 W** | **1083 W** |

A corrente da bateria também é subnotificada: com 1083 W no MPPT2 e 331 W de saída, o
`QPIGS` reportou **5 A** de carga enquanto a nuvem mostrava **12 A**. Por isso o coletor
publica `battery.current_partial = true` e o painel mostra **"Carga da bateria (parcial)"**.

Consequência prática: o **balanço DC** desse inversor (`saída + carga − descarga`) é um
**piso**, exibido como `balanço DC ≥ N W`. Ele nunca é publicado como "geração".

## Painel web

`http://127.0.0.1:3071` — Node.js + Express, sem framework de front-end.

O painel é **passivo em relação aos inversores**: não envia UDP aos dongles, não abre a
porta 8899 e não mexe na nuvem. Ele consulta o coletor ao vivo em
`http://127.0.0.1:8080/status` e usa `data/latest.json` apenas como *fallback*, então
nunca se torna um segundo coletor concorrente.

**Visão geral**

- chips no topo: leitura ao vivo/atrasada, tempo desde a última leitura, `2/3 online`,
  inversores sem resposta e falhas de ação — cada um com detalhe no tooltip;
- cartões de resumo (SOC médio, geração solar, potência entregue) somando **apenas**
  quem respondeu;
- um card por inversor com 9 métricas: potência de saída, geração solar, carga no
  inversor, temperatura do inversor, temperatura do painel, tensão da bateria, corrente
  de carga, corrente de descarga e tensão PV;
- linha de diagnóstico sob as métricas: `MPPT1 227 W · MPPT2 346 W` no `.59`, ou
  `MPPT2 não é exposto por este inversor · balanço DC ≥ 283 W` no `.106`;
- barra de bateria colorida por faixa, aviso de bateria baixa abaixo de 30 % e nome
  amigável persistido em `data/dashboard.json`;
- nada é arredondado para "0": ausência de leitura aparece como `—` com o motivo no
  tooltip, e não como zero.

**Ações automáticas**

- regras por ação, cada uma com seu inversor de referência e sua faixa de SOC;
- chip por regra (`Normal`, `Pausado`, `Reduzido`, `Liberada`, `Conflito`, `Falha`,
  `Desligada`, `Sem leitura`, `Mantida`);
- estado real dos alvos (fila do Gate, threads do XMRig, CPUQuota do ai-node) e hash
  rate de agora, 1 min e 15 min;
- último resultado de cada regra visível na linha, com o detalhe técnico no tooltip.

## Automação por SOC

Três ações independentes, todas disparadas pelo SOC de **um** inversor escolhido em cada
regra:

| Ação | Aplicada quando o SOC cai | Liberada quando o SOC sobe |
| --- | --- | --- |
| `gate_pause` | `POST /v1/admin/pausar` no Gate (fila de jobs) | `POST /v1/admin/retomar` |
| `ep2_mining_reduce` | XMRig da EP2 reiniciado com menos threads | restaura as threads do perfil |
| `ainode_mining_reduce` | `ainode-mining-mode ai <percentual>` via SSH | `ainode-mining-mode normal` |

Cada regra tem `activateBelow`, `resumeAbove` e `desiredIntensity` próprios, e todas as
faixas são configuráveis pela interface (validação: 0–100 e `resumeAbove > activateBelow`).

### Ciclo de vida

O executor roda a cada 10 s (`DASHBOARD_POLL_MS`) e segue sempre o mesmo contrato:

| Situação | O que acontece |
| --- | --- |
| SOC abaixo de `activateBelow` | aplica a ação (pausa/reduz) |
| SOC entre os dois limites | mantém o último alvo (histerese), sem alternar |
| SOC acima de `resumeAbove` | libera (retoma/restaura o máximo) |
| SOC indisponível | não mexe em nada e mantém o estado aplicado |
| regra desabilitada ou excluída | libera o recurso que ela havia aplicado |
| ação já está no estado desejado | não repete o comando (idempotente) |
| o comando falhou | registra `Falha` naquela regra sem interromper as outras |

O estado fica em `data/automation-state.json` e é hidratado no restart: uma ação aplicada
antes de reiniciar o serviço continua aplicada e é liberada no momento certo.

### Pausa do Gate: posse e conflito

A pausa é identificada por `pausedAt` em `GET /v1/status`. A automação só retoma uma
pausa **que ela mesma criou**:

- ao pausar, guarda o `pausedAt` devolvido pelo Gate;
- ao liberar, compara o `pausedAt` atual com o guardado — se mudou, registra `Conflito` e
  **não retoma** (a pausa é de outra pessoa ou sistema);
- pausa feita manualmente no painel do Gate nunca é desfeita pela automação.

Sem essa checagem, automação e operador desfazem um ao outro: a regra em histerese
reaplicava `retomar` logo depois de uma pausa manual.

### EP2: threads reais, não linha de comando

A redução reinicia o XMRig com `--threads=N` e depois **confirma** o resultado em
`GET /2/backends` (o `/2/summary` traz `threads: null`). Se outro ator mudar o perfil, a
diferença é corrigida no ciclo seguinte.

> ⚠️ O `config.json` do XMRig da EP2 precisa de **`"watch": false`**. Com `watch: true`
> ele recarregava o arquivo sozinho e voltava ao perfil automático (30 threads), anulando
> a redução mesmo com `--threads=3`. Durante a inicialização o backend publica threads
> parciais e sem `profile`, e o executor ignora essa leitura.

### Verificação manual

```powershell
# estado real dos alvos
Invoke-RestMethod http://192.168.18.150:3070/v1/status | Select-Object -ExpandProperty gate
Invoke-RestMethod http://127.0.0.1:18092/2/backends | ConvertTo-Json -Depth 4   # threads reais
ssh ai-node '/usr/local/sbin/ainode-mining-mode status'                        # CPUQuota

# o que a automação decidiu/aplicou
Invoke-RestMethod http://127.0.0.1:3071/api/dashboard | Select-Object -ExpandProperty execution
```

## Quando um inversor fica offline

Um dongle pode sumir da rede (sem energia, DHCP novo, Wi-Fi caído). O sistema continua
útil nesse cenário:

| Camada | Comportamento |
| --- | --- |
| Coleta | Timeout curto (`--connect-timeout`, padrão **10 s**) por dongle: um aparelho morto não trava o ciclo |
| Coleta | Os demais inversores são lidos normalmente no mesmo ciclo |
| Snapshot | `online: false`, `error` com o motivo em português e `last_ok` com a hora da última leitura boa |
| Snapshot | Gravação atômica (`arquivo.tmp` + `os.replace`): a UI nunca lê JSON pela metade |
| Painel | O card mostra `Sem resposta` e, no lugar da barra, desde quando não há leitura |
| Painel | Chips `2/3 online` e `<nome> sem resposta`, com o motivo no tooltip |
| Resumo | SOC médio e potências somam **apenas** quem respondeu (o tooltip diz isso) |
| Automação | Sem SOC da referência, nenhuma decisão é tomada: a regra fica `Sem leitura` e nada é liberado nem intensificado às cegas |
| Automação | Se a ação já estava aplicada, ela **continua** aplicada e a regra mostra `Mantida` |
| Integrações | Gate, XMRig e ai-node offline aparecem como `Sem resposta` com o motivo |

`data/automation-state.json` e `data/dashboard.json` passam pelo `JsonStore`: se o
arquivo vier corrompido (encerramento forçado no meio da escrita deixa bytes `NUL`), ele é
movido para `*.corrupt-<data>` e o painel recomeça do padrão em vez de falhar.

## Instalação

Requisitos: **Python 3.10+** na mesma rede dos dongles; **Node.js 20+** apenas para o
painel.

```bash
git clone https://github.com/Dricosr/inverter-monitor.git
cd inverter-monitor
```

O coletor não precisa de `pip install`: não há dependências. O painel precisa de
`npm install` (só `express`).

Ajuste [`devices.json`](devices.json) se os IPs forem outros:

```json
[
  { "name": "anenji-6k2",   "ip": "192.168.18.33",  "protocol": "modbus_a", "soc_on": 60, "soc_off": 45 },
  { "name": "inversor-59",  "ip": "192.168.18.59",  "protocol": "modbus_b", "soc_on": 60, "soc_off": 45 },
  { "name": "inversor-106", "ip": "192.168.18.106", "protocol": "pi30",     "soc_on": 60, "soc_off": 45 }
]
```

`"protocol"` pode ser omitido — nesse caso a detecção automática testa os três (mais
lenta). Os valores em `"name"` viram as chaves do JSON e as rotas da API. Reservar IP
fixo no roteador evita ter de editar o arquivo.

Variáveis de ambiente do painel: `PORT` (3071), `HOST`, `INVERTER_COLLECTOR_URL`,
`INVERTER_SNAPSHOT_FILE`, `INVERTER_DASHBOARD_FILE`, `INVERTER_DEVICES_FILE`,
`DASHBOARD_POLL_MS` (10000), `GATE_BASE_URL`, `EP2_XMRIG_URL`, `EP2_XMRIG_CONFIG`,
`EP2_XMRIG_TOKEN`, `EP2_MINING_BASE_THREADS` (30), `AUTOMATION_ENABLED` (true),
`AUTOMATION_STATE_FILE`.

## Linha de comando

| Comando | O que faz |
| --- | --- |
| `python inverter_monitor.py --probe 192.168.18.33` | Testa um dongle e mostra o que responde (detecção automática) |
| `python inverter_monitor.py --once` | Um ciclo, imprime o JSON e grava `data/latest.json` |
| `python inverter_monitor.py` | Serviço contínuo + API HTTP em `:8080` |
| `python inverter_monitor.py --interval 15 --http 8080` | Ciclo a cada 15 s (padrão: 10 s) |
| `python inverter_monitor.py --http 0` | Sem HTTP, só grava o arquivo |
| `python inverter_monitor.py -v --once` | Log detalhado, mostrando por que cada protocolo falhou |
| `python inverter_monitor.py --connect-timeout 15` | Timeout por dongle (padrão: 10 s) |
| `python inverter_monitor.py --version` | Versão |

Código de saída: `0` se todos os inversores responderam, `1` se algum falhou (útil em
cron/agendador).

## API HTTP

### Coletor (porta 8080)

| Rota | Retorno |
| --- | --- |
| `GET /status` | JSON completo, com todos os inversores |
| `GET /status/<nome>` | JSON de um inversor (ex.: `/status/inversor-106`) |
| `GET /health` | `{"ok": true}`, `200` se o último ciclo rodou há menos de 120 s; senão `503` |

```powershell
$s = Invoke-RestMethod http://localhost:8080/status
$s.devices.'inversor-59'.battery.soc            # 62
$s.devices.'inversor-59'.pv.mppt_power          # 203, 321
$s.devices.'inversor-106'.battery.current_partial  # True
```

```bash
curl -s http://localhost:8080/status/inversor-59 | jq .pv
```

### Painel (porta 3071)

| Rota | Método | Retorno |
| --- | --- | --- |
| `/api/dashboard` | GET | Inversores normalizados, integrações, regras e estado de execução |
| `/api/devices/<id>` | PUT | Salva o nome exibido (`{ "displayName": "..." }`) |
| `/api/rules` | POST | Cria regra (`id`, `name`, `action`, `sourceDeviceId`, `activateBelow`, `resumeAbove`, `desiredIntensity`, `enabled`) |
| `/api/rules/<id>` | PUT / DELETE | Atualiza ou exclui uma regra |
| `/health` | GET | `{"ok": true, "port": 3071, "automationEnabled": true}` |

`action` aceita `gate_pause`, `ep2_mining_reduce` ou `ainode_mining_reduce`.

## Formato do JSON

Cada dispositivo é um objeto. Campos com `*` dependem do protocolo.

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `ip` | string | IP do dongle |
| `protocol` | `modbus_a` \| `modbus_b` \| `pi30` | Protocolo detectado/configurado |
| `online` | bool | `true` se o ciclo conseguiu ler |
| `error` | string | Presente apenas quando `online = false` |
| `last_ok` | string \| null | ISO-8601 da última leitura boa |
| `mode` | string \| null | Modo de operação (`Off-Grid`, `Battery`, `Line`, `Standby`…) |
| `status_code`* | int | Código bruto do modo (`modbus_b`), útil para diagnóstico |
| `serial`* | string | Serial informado pelo `QID` (`pi30`) — ver ressalva acima |
| `battery.soc` | int | **SOC em %** |
| `battery.voltage` | float | Tensão da bateria (V) |
| `battery.current`* | float | Corrente (A); negativo = descarregando (`modbus_a`/`modbus_b`) |
| `battery.power`* | float | Potência (W); negativo = descarregando |
| `battery.current_charge`* | float | Corrente de carga (A) — só `pi30` |
| `battery.current_discharge`* | float | Corrente de descarga (A) — só `pi30` |
| `battery.current_partial`* | bool | `true` no `pi30` quando as correntes não cobrem todos os MPPTs |
| `battery.voltage_scc`* | float | Tensão vista pelo SCC (V) — só `pi30` |
| `battery.temperature`* | int | Temperatura informada pelo protocolo (mapa A); no mapa B use `temperature.dcdc` |
| `pv.voltage` | float \| null | Tensão PV (V) |
| `pv.voltage2`* | float | Tensão do 2º MPPT (`modbus_b`) |
| `pv.current`* | float | Corrente PV (A) |
| `pv.power`* | float \| null | Potência PV (W) — medida (regs 353/391); **só do MPPT1** no `pi30` |
| `pv.mppt_power`* | float[] \| null | Potência de cada entrada PV em W (`modbus_b`) |
| `pv.mppt`* | int | Entrada que os campos acima descrevem (`pi30`: sempre `1`) |
| `pv.mppt_count`* | int | Quantas entradas o modelo tem (`pi30`: `2`) |
| `pv.mppt_unreadable`* | int[] | Entradas que o firmware não expõe (`pi30`: `[2]`) |
| `pv.dc_balance`* | float | Balanço medido no lado DC: saída + carga − descarga (W) |
| `grid.voltage` | float \| null | Tensão da rede (V); `null` se não exposta |
| `grid.frequency` | float \| null | Frequência da rede (Hz) |
| `output.voltage` | float | Tensão de saída (V) |
| `output.current` | float | Corrente de saída (A) |
| `output.frequency` | float | Frequência de saída (Hz) |
| `output.active_power` | int | Potência ativa (W) |
| `output.apparent_power` | int | Potência aparente (VA) |
| `load_percent`* | int | Carga em % do nominal |
| `bus_voltage`* | int | Tensão do barramento DC (só `pi30`) |
| `temperature.inverter`* | int | Temperatura do inversor (°C) — os três protocolos |
| `temperature.dcdc`* | int | Temperatura do módulo DC (°C) — `modbus_a` (226) e `modbus_b` (281) |
| `temperature.pv`* | int | Temperatura do painel (°C) — `modbus_b` (305) |
| `automation` | objeto | Presente quando há `soc_on`/`soc_off` — ver [automação](#automação-por-soc) |

Um exemplo real e completo está em
[`examples/sample-output.json`](examples/sample-output.json).

## Integração com outros sistemas

**PowerShell** — [`examples/powershell.ps1`](examples/powershell.ps1)

```powershell
$s = Invoke-RestMethod http://localhost:8080/status
if ($s.devices.'inversor-106'.automation.should_run) { Start-Servidor } else { Stop-Servidor }
```

**Python (uso como biblioteca)** — [`examples/library_usage.py`](examples/library_usage.py)

```python
import inverter_monitor as im

link = im.Dongle("192.168.18.106")
try:
    dados = im.read_pi30(link)
finally:
    link.close()

print(dados["battery"]["soc"], "%")
```

**Home Assistant** — `rest` sensor apontando para `/status/<nome>`:

```yaml
sensor:
  - platform: rest
    name: "Inversor 59 SOC"
    resource: http://192.168.18.131:8080/status/inversor-59
    value_template: "{{ value_json.battery.soc }}"
    unit_of_measurement: "%"
    scan_interval: 30
```

**cron** (Linux, a cada minuto):

```cron
* * * * * cd /opt/inverter-monitor && python3 inverter_monitor.py --once --http 0 >/dev/null
```

## Rodar como serviço

**Windows (recomendado)** — os scripts de [`deploy/`](deploy) registram tarefas
**ocultas**, com gatilho de boot **e** de logon, reinício automático e sem limite de tempo:

```powershell
pwsh -File deploy\install-collector.ps1   # coletor Python -> tarefa InverterMonitorCollector
pwsh -File deploy\install-ui.ps1          # painel Node.js -> tarefa InverterMonitorUI
```

As tarefas aparecem como `InverterMonitorCollector` e `InverterMonitorUI`; os scripts
liberam as portas 8080 e 3071 no firewall e encerram a instância anterior antes de subir
a nova, para não deixar processo órfão segurando a porta.

```powershell
Start-ScheduledTask -TaskName InverterMonitorCollector   # reiniciar após mudança de código
Get-ScheduledTaskInfo -TaskName InverterMonitorCollector | Select-Object LastRunTime, LastTaskResult
```

**Linux** — `systemd`:

```ini
# /etc/systemd/system/inverter-monitor.service
[Unit]
Description=Monitor local dos inversores
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/inverter-monitor
ExecStart=/usr/bin/python3 inverter_monitor.py --interval 30 --http 8080
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now inverter-monitor
```

## Estrutura do repositório

```text
inverter-monitor/
├─ inverter_monitor.py   coletor, parsers e API HTTP (somente stdlib)
├─ devices.json          nome, IP, protocolo e histerese de SOC de cada inversor
├─ docs/PROTOCOL.md      engenharia reversa: framing, campos fc e mapas de registradores
├─ src/                  painel Node.js
│  ├─ server.mjs         Express, /health e inicialização da automação
│  ├─ config.mjs         configuração por variáveis de ambiente
│  ├─ domain/            normalização do status, avaliação das regras, helpers
│  ├─ services/          integrações e executores de ação (services/automation/)
│  └─ routes/            API do painel
├─ public/               HTML, CSS, JS e ícone do painel
├─ deploy/               tarefas agendadas e script de threads do XMRig
├─ examples/             saída real, uso como biblioteca e PowerShell
├─ tests/                parsers e poll (Python) e automação (Node)
└─ data/                 estado em tempo de execução (ignorado pelo Git)
```

## Testes

```bash
# parsers, CRC, framing e poll (39 testes, nenhum toca a rede)
python -m unittest discover -s tests -v

# automação, integrações e normalização do painel (30 testes)
npm test
```

Os testes em Python usam bytes capturados de equipamentos reais; os do painel usam
executores falsos, sem tocar no Gate, no SSH ou no XMRig.

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| `porta 8899 ocupada` | Outra instância rodando | Feche a outra instância — a porta é fixa no firmware |
| `porta 8080 ja esta em uso` | Segundo coletor iniciado por engano | O processo novo encerra sozinho; mantenha um só (`Get-NetTCPConnection -LocalPort 8080`) |
| `nao conectou de volta em 10s` | Dongle offline, IP mudou ou já conectado a outro servidor | `ping` no IP; confira `devices.json`; rode com `-v` |
| `nenhum protocolo conhecido respondeu` | Mapa diferente do esperado | `--probe` com `-v` e ajuste o `"protocol"` |
| `resposta Modbus invalida` | Registrador fora da faixa ou dongle atropelado | Só leitura; o coletor já repete uma vez e espaça as requisições em 50 ms |
| Inversor com `online: false` | Dongle sem energia, fora do Wi-Fi ou IP novo | `ping <ip>`; se o ARP não resolver, é o aparelho. Confira `last_ok` |
| Ciclo lento | Dongle morto gastando todo o timeout | Ajuste `--connect-timeout` ou confira `devices.json` |
| Painel em 500 | Arquivo de estado corrompido | O `JsonStore` já se recupera e guarda `*.corrupt-<data>` |
| SOC `0` com todos os campos zerados | Mapa errado respondendo com zeros | A validação de plausibilidade já rejeita isso na detecção |
| `Geração solar 0 W` no `.106` de dia | MPPT1 sem painéis; a geração está no MPPT2, que não é legível | Esperado. Compare com o balanço DC (`≥`) |
| `Corrente de carga (parcial)` | `QPIGS` não cobre o MPPT2 | Esperado. Use o valor da nuvem como referência |
| Temperatura `—` | Modelo não expõe aquele sensor | Esperado; o tooltip da métrica explica |
| EP2 volta às threads máximas sozinha | `"watch": true` no `config.json` do XMRig | Use `"watch": false` |
| Regra em `Conflito` | A pausa do Gate foi criada por outra origem | A automação não desfaz pausa alheia; libere manualmente |
| Firewall do Windows pedindo liberação | Conexão de **entrada** na 8899 | Permita para rede privada |
| `NAK` / valores de `QPIGS` deslocados | CRC errado | Use `pi30()` do módulo — o init do CRC é `0x0000` |

## Limitações e efeitos colaterais

- **O app oficial fica sem dados enquanto estamos conectados.** O dongle mantém uma
  conexão por vez. Com `--interval 15`, cada dongle fica conectado localmente apenas
  durante uma leitura curta e o coletor aguarda **1,5 s** antes do próximo
  redirecionamento. O app oficial pode atrasar alguns minutos e volta ao normal depois
  que o dongle reconecta à nuvem. Não há proxy permanente neste modo.
- **A porta 8899 é exclusiva.** Só um processo pode usá-la, e o coletor também exige a
  porta HTTP livre: se outra instância já estiver na 8080, a nova encerra em vez de rodar
  em paralelo.
- **O `.106` não expõe o MPPT2** e subnotifica a corrente da bateria (ver
  [acima](#o-caso-do-mps-102-106)). Nenhum comando PI30 aceito por essa unidade devolve a
  segunda entrada PV.
- `inversor-59` publica modo, carga, temperaturas e PV, mas **não** tensão de rede — os
  registradores 202/203 respondem zero nesse modelo.
- Em `pi30`, `current_charge` tem 1 decimal e `current_discharge` é inteiro.
- O registrador 343 do mapa B varia com a carga (~47–49 °C) mas **não** é a temperatura
  que o fabricante publica; ele é lido e descartado.
- Se o dongle trocar de IP (DHCP), ajuste `devices.json`. Recomendado: reserva de IP no
  roteador.
- O caminho de coleta é **somente leitura**. Nenhum registrador de configuração do
  inversor é escrito. As únicas escritas acontecem nas ações de automação, e apenas nos
  alvos externos (Gate, XMRig, ai-node).

## Roadmap

- [ ] Expor tensão/frequência de rede no `.59` caso o firmware passe a responder os
      registradores 202/203.
- [ ] Procurar um comando/driver que devolva o MPPT2 do `.106` (o dongle o conhece, mas
      só o expõe no canal da nuvem).
- [ ] Publicar os alarmes do `.106`: o `QPIWS` **responde** (`0000010000…`), falta validar
      o mapeamento bit a bit antes de mostrar na tela.
- [ ] Energia acumulada (kWh do dia) — a nuvem mostra; os registradores ainda não foram
      localizados no mapa B.
- [ ] Modo *proxy*: manter nuvem **e** local simultâneos, redirecionando
      `ess.eybond.com` no DNS do roteador e repassando para o servidor real
      (ideia de [`powmr-eybond-proxy`]).
- [ ] Publicação opcional em MQTT com *discovery* para Home Assistant.

## Referências

- [`powmr-eybond-proxy`] — proxy DNS para dongles Eybond.
- [`anenji-local-modbus`] — mapa de registradores de um Anenji específico.
- `mpp-solar` — implementação de referência do PI30 (Voltronic/Axpert).
- Protocolo PI30: comandos `QPIGS`, `QPIRI`, `QMOD` e o CRC-16/XMODEM com correção dos
  bytes `0x28`, `0x0D` e `0x0A`.
- Evidência local × nuvem deste projeto: [docs/PROTOCOL.md](docs/PROTOCOL.md).

[`powmr-eybond-proxy`]: https://github.com/leodeslf/powmr-eybond-proxy
[`anenji-local-modbus`]: https://github.com/leodeslf/anenji-local-modbus

## Licença

MIT — veja [LICENSE](LICENSE).
