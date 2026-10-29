# ⚡ Monitor local dos inversores híbridos (LAN)

![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![Node.js](https://img.shields.io/badge/node.js-20%2B-5FA04E)
![Dependências](https://img.shields.io/badge/depend%C3%AAncias-nenhuma-brightgreen)
![Testes](https://img.shields.io/badge/testes-18%20passando-brightgreen)
![Licença](https://img.shields.io/badge/licen%C3%A7a-MIT-green)
![Plataforma](https://img.shields.io/badge/plataforma-windows%20%7C%20linux%20%7C%20macos-lightgrey)

Leitura **direta pela rede local**, sem nuvem, dos inversores híbridos com dongle
WiFi da família **Eybond / DessMonitor** — a mesma dos apps *SmartESS*, *DESS Monitor*
e *Wi-Fi Pro*.

Entrega SOC da bateria, tensão, corrente, potência, PV, carga e temperatura em JSON,
com API HTTP pronta para automação. **Sem dependências externas**: só a biblioteca
padrão do Python 3.10+.

```
anenji-6k2     Off-Grid  SOC  48%   53.1V
inversor-59              SOC  54%   52.1V   -4.2A / -218W
inversor-106   Battery   SOC  41%   52.3V   905W / carga 12%
```

---

## Sumário

- [Por que existe](#por-que-existe)
- [Como funciona](#como-funciona)
- [O que foi descoberto na rede](#o-que-foi-descoberto-na-rede)
- [Instalação](#instalação)
- [Uso pela linha de comando](#uso-pela-linha-de-comando)
- [Painel Node.js](#painel-nodejs)
- [API HTTP](#api-http)
- [Formato do JSON](#formato-do-json)
- [Automação com histerese de SOC](#automação-com-histerese-de-soc)
- [Integração com outros sistemas](#integração-com-outros-sistemas)
- [Rodar como serviço](#rodar-como-serviço)
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
escuta portas TCP, achar o gatilho UDP que os reverte para a LAN e, a partir daí,
identificar **três protocolos diferentes** atrás de dongles aparentemente iguais.

O objetivo prático era ler o SOC da bateria para decidir quando ligar equipamentos do
escritório — e para isso não dá para depender de latência de nuvem nem de cota de API.

## Como funciona

```
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
  /status (HTTP)  ·  data/latest.json
```

1. O dongle é convencido a trocar o servidor de destino por este PC (comando UDP).
2. Ele abre uma conexão TCP **para nós** na porta 8899 (fixa no firmware).
3. Nessa conexão trafegam frames no formato Eybond:

   ```
   tid:u16   dev:u16   len:u16   addr:u8   fc:u8   payload
   (big-endian; len conta addr + fc + payload)
   ```

4. Com `fc=4` o payload é repassado **cru** ao inversor. É assim que lemos `QPIGS`
   (ASCII) ou frames Modbus RTU.

O detalhamento — incluindo as armadilhas do CRC, o significado dos `fc` e os três mapas
de registradores — está em **[docs/PROTOCOL.md](docs/PROTOCOL.md)**.

## Painel Node.js

O painel web em Node.js fica em **`http://127.0.0.1:3071`** e foi projetado para
acompanhamento apenas. Ele não envia UDP aos dongles, não abre a porta `8899`, não
mexe na nuvem dos inversores e não executa comandos no Gate ou nas mineradoras.

```powershell
cd D:\inverter-monitor
npm install
npm start
```

O painel lê `data/latest.json`, que continua sendo produzido pelo coletor Python.
O painel consulta primeiro o coletor ao vivo em `http://127.0.0.1:8080/status` e usa
o arquivo apenas como fallback quando o serviço está indisponível.
Portanto, ele nunca se torna um segundo coletor concorrente. Entre os recursos:

- SOC, bateria, PV, carga, saída e temperatura por inversor;
- timestamp e idade do último snapshot, indicando claramente quando o coletor parou;
- nomes amigáveis persistidos em `data/dashboard.json`;
- estado do Gate e das integrações EP2/ai-node quando disponíveis;
- regras de SOC com ativação abaixo do limite e retorno acima da faixa de histerese;
- associação explícita de cada regra a um inversor;
- intensidade desejada para EP2 e ai-node, sem acionamento físico nesta versão.

Execução física permanece bloqueada. A API informa `execution.enabled=false`, e
todas as intenções exibem `executionEnabled=false` mesmo quando a faixa estiver
atingida.

## Leituras ao vivo

O coletor publica novos snapshots a cada 15 segundos em
`http://127.0.0.1:8080/status`. A UI consulta essa API diretamente a cada 10 segundos.
O arquivo `data/latest.json` é usado somente como fallback temporário.

## O que foi descoberto na rede

Varredura de `192.168.18.0/24` (ping + ARP + TCP 1–65535 + UDP discovery). Dez
dispositivos na rede; três deles são os dongles dos inversores:

| Nome           | IP             | Chip      | Protocolo do inversor                          | Observação                        |
| -------------- | -------------- | --------- | ---------------------------------------------- | --------------------------------- |
| `anenji-6k2`   | 192.168.18.33  | Espressif | Modbus RTU — mapa **EG4 3000EHV** (200–344)    | reg. 643 = **6200 W** nominal     |
| `inversor-59`  | 192.168.18.59  | Quectel   | Modbus RTU — mapa **Anenji** (bateria 277–281) | também expõe UI web na porta 80   |
| `inversor-106` | 192.168.18.106 | Espressif | ASCII **PI30** (`QPIGS` / `QMOD`)              | serial `55355535553555`, FW `00152.02` |

Outros equipamentos vistos, que **não** são inversores: `.1` roteador Huawei,
`.5` PC Gigabyte, `.41` e `.66` dispositivos Tuya, `.150` DUX, `.200` BMC ASRock.

> Os dongles `.33`, `.59` e `.106` não têm **nenhuma** porta TCP aberta em repouso.
> É exatamente por isso que `nmap`, Modbus TCP e as integrações tradicionais falham.

## Instalação

Requisitos: **Python 3.10+** e estar na mesma rede dos dongles.

```bash
git clone https://github.com/Dricosr/inverter-monitor.git
cd inverter-monitor
```

Não há `pip install` — não há dependências.

Se os IPs forem outros, ajuste [`devices.json`](devices.json):

```json
[
  { "name": "anenji-6k2",  "ip": "192.168.18.33",  "protocol": "modbus_a" },
  { "name": "inversor-59", "ip": "192.168.18.59",  "protocol": "modbus_b" },
  { "name": "inversor-106","ip": "192.168.18.106", "protocol": "pi30"     }
]
```

`"protocol"` pode ser omitido — nesse caso a detecção automática é usada (mais lenta,
pois testa os três). Os valores em `"name"` viram as chaves do JSON e as rotas da API.

## Uso pela linha de comando

| Comando | O que faz |
| --- | --- |
| `python inverter_monitor.py --probe 192.168.18.33` | Testa um dongle e mostra o que responde (com detecção automática) |
| `python inverter_monitor.py --once` | Um ciclo, imprime o JSON e grava `data/latest.json` |
| `python inverter_monitor.py` | Serviço contínuo + API HTTP em `:8080` |
| `python inverter_monitor.py --interval 30 --http 8080` | Intervalo de 30 s entre ciclos |
| `python inverter_monitor.py --interval 10 --http 0` | Sem HTTP, só grava o arquivo |
| `python inverter_monitor.py -v --once` | Log detalhado (mostra por que um protocolo falhou) |
| `python inverter_monitor.py --version` | Versão |

Saída de `--once` (recortada):

```json
{
  "timestamp": "2026-10-23T21:42:56-03:00",
  "devices": {
    "inversor-106": {
      "ip": "192.168.18.106",
      "protocol": "pi30",
      "online": true,
      "mode": "Battery",
      "battery": { "soc": 41, "voltage": 52.3, "current_discharge": 21.0 },
      "output": { "voltage": 229.9, "active_power": 905 },
      "load_percent": 12,
      "temperature": { "inverter": 48 }
    }
  }
}
```

Código de saída: `0` se todos os inversores responderam, `1` se algum falhou
(útil em cron/agendador).

## API HTTP

Servida quando `--http` é diferente de `0` (padrão `8080`).

| Rota | Retorno |
| --- | --- |
| `GET /status` | JSON completo, com todos os inversores |
| `GET /status/<nome>` | JSON de um inversor (ex.: `/status/inversor-106`) |
| `GET /health` | `{"ok": true}` — `200` se o último ciclo rodou há menos de 120 s; senão `503` |

```powershell
$s = Invoke-RestMethod http://localhost:8080/status
$s.devices.'inversor-106'.battery.soc      # 41
$s.devices.'inversor-106'.battery.voltage  # 52.3
```

```bash
curl -s http://localhost:8080/status/inversor-106 | jq .battery
```

## Formato do JSON

Cada dispositivo é um objeto. Campos com `*` dependem do protocolo.

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `ip` | string | IP do dongle |
| `protocol` | `modbus_a` \| `modbus_b` \| `pi30` | Protocolo detectado/configurado |
| `online` | bool | `true` se o ciclo conseguiu ler |
| `error` | string | Presente apenas quando `online = false` |
| `mode` | string \| null | Modo de operação (ex.: `Off-Grid`, `Battery`, `Line`) |
| `serial`* | string | Serial do inversor (só `pi30`) |
| `battery.soc` | int | **SOC em %** |
| `battery.voltage` | float | Tensão da bateria (V) |
| `battery.current`* | float | Corrente (A); negativo = descarregando (`modbus_a`/`modbus_b`) |
| `battery.power`* | int | Potência (W); negativo = descarregando |
| `battery.temperature`* | int | Temperatura do módulo DC (°C) |
| `battery.current_charge`* | float | Corrente de carga (A) — só `pi30` |
| `battery.current_discharge`* | float | Corrente de descarga (A) — só `pi30` |
| `battery.voltage_scc`* | float | Tensão vista pelo SCC (V) — só `pi30` |
| `pv.voltage` | float \| null | Tensão PV (V) |
| `pv.current`* | float | Corrente PV (A) |
| `pv.power`* | int | Potência PV (W) |
| `pv.voltage2`* | float | Tensão do 2º MPPT (`modbus_b`) |
| `grid.voltage` | float \| null | Tensão da rede (V); `null` se não exposta |
| `grid.frequency` | float \| null | Frequência da rede (Hz) |
| `output.voltage` | float | Tensão de saída (V) |
| `output.frequency` | float | Frequência de saída (Hz) |
| `output.current` | float | Corrente de saída (A) |
| `output.active_power` | int | Potência ativa (W) |
| `output.apparent_power` | int | Potência aparente (VA) |
| `load_percent`* | int | Carga em % |
| `bus_voltage`* | int | Tensão do barramento DC (só `pi30`) |
| `temperature.dcdc` | int | Temperatura do DCDC (°C) |
| `temperature.inverter` | int | Temperatura do inversor (°C) |
| `automation` | objeto | Presente quando há `soc_on`/`soc_off` — ver abaixo |

Um exemplo real e completo está em [`examples/sample-output.json`](examples/sample-output.json).

## Automação de cargas com histerese de SOC

Em `devices.json`, cada inversor aceita `soc_on` e `soc_off`. A saída passa a incluir:

```json
"automation": {
  "should_run": true,
  "soc_on": 60,
  "soc_off": 45,
  "reason": "soc>=on"
}
```

| Situação | `should_run` |
| --- | --- |
| `soc >= soc_on` | `true` |
| `soc <= soc_off` | `false` |
| entre os dois | mantém o estado anterior (histerese) |

A histerese evita o liga/desliga oscilando quando o SOC fica na borda.

Além dessa decisão usada pela API Python, o painel Node.js possui automação física
independente para três ações configuradas pela interface:

| Ação | Estado ativo | Estado normal |
| --- | --- | --- |
| Gate | `POST /v1/admin/pausar` | `POST /v1/admin/retomar` |
| EP2 | XMRig reiniciado com threads proporcionais à intensidade reduzida | restaura 30 threads |
| ai-node | `ainode-mining-mode ai <percentual>` via SSH autorizado | `ainode-mining-mode normal` |

Cada regra escolhe seu próprio inversor de referência, limiares de ativação e
retomada e intensidade reduzida. O executor mantém estado persistido e verifica o
estado real antes de enviar a ação; falhas em uma regra não interrompem as demais.
Gate não é alterado por este projeto.

### Ciclo de vida de cada ação

O executor roda a cada 10 s (`DASHBOARD_POLL_MS`) e segue sempre este contrato:

| Situação | O que acontece |
| --- | --- |
| SOC abaixo de `activateBelow` | aplica a ação (pausa/reduz) |
| SOC entre os dois limites | mantém o último alvo (histerese), sem alternar |
| SOC acima de `resumeAbove` | libera (retoma/restaura o máximo) |
| SOC indisponível | não mexe em nada, mantém o estado aplicado |
| regra desabilitada ou excluída | libera o recurso que ela havia aplicado |
| ação já está no estado desejado | não repete o comando (idempotente) |

### Pausa do Gate: posse e conflito

A pausa do Gate é identificada por `pausedAt` em `GET /v1/status`. A automação só
retoma uma pausa **que ela mesma criou**:

- ao pausar, guarda o `pausedAt` devolvido pelo Gate;
- ao liberar, compara o `pausedAt` atual com o guardado — se mudou, registra
  `conflito` e **não retoma** (a pausa é de outra pessoa/sistema);
- pausa feita no painel do Gate nunca é desfeita pela automação.

Sem essa checagem a automação e o operador ficam se desfazendo mutuamente: a regra
em histerese reaplicava `retomar` logo depois de uma pausa manual.

### Verificação

```powershell
# estado real dos três alvos
Invoke-RestMethod http://192.168.18.150:3070/v1/status | Select-Object -ExpandProperty gate

# EP2: threads reais do processo
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'xmrig.exe' }

# ai-node: CPUQuota aplicado
ssh ai-node '/usr/local/sbin/ainode-mining-mode status'

# o que a automação decidiu/aplicou
Invoke-RestMethod http://127.0.0.1:3071/api/dashboard | Select-Object -ExpandProperty execution
```

Testes: `npm test` cobre independência das ações, histerese, liberação ao desabilitar
ou excluir a regra, isolamento de falhas, hidratação do estado no restart e conflito
de pausa.

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
    name: "Inversor 106 SOC"
    resource: http://192.168.18.131:8080/status/inversor-106
    value_template: "{{ value_json.battery.soc }}"
    unit_of_measurement: "%"
    scan_interval: 30
```

**cron** (Linux, a cada minuto):

```cron
* * * * * cd /opt/inverter-monitor && python3 inverter_monitor.py --once --http 0 >/dev/null
```

## Rodar como serviço

**Windows** — tarefa agendada que sobe no boot, sem sessão aberta:

```powershell
$py = (Get-Command python).Source
schtasks /Create /TN "InverterMonitor" /SC ONSTART /RU SYSTEM /RL HIGHEST `
  /TR "\"$py\" \"D:\inverter-monitor\inverter_monitor.py\" --interval 30 --http 8080"
```

Remover: `schtasks /Delete /TN "InverterMonitor" /F`

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

## Testes

```bash
python -m unittest discover -s tests -v
```

18 testes cobrindo CRC (Modbus e PI30), framing Eybond, `rtu_read` e os três parsers,
usando bytes capturados de equipamentos reais. Nenhum teste toca a rede.

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| `porta 8899 ocupada` | Outra instância rodando | Feche a outra instância — a porta é fixa no firmware |
| `nao conectou de volta em 25s` | Dongle offline, IP mudou ou já conectado a outro servidor | `ping` no IP; confira `devices.json`; rode com `-v` |
| `nenhum protocolo conhecido respondeu` | Mapa diferente do esperado | `--probe` com `-v` e ajuste o `"protocol"` |
| `resposta Modbus invalida` | Endereço de registrador fora da faixa | Só leitura; não há escritas no código |
| SOC `0` com todos os campos zerados | Mapa errado respondendo com zeros | A validação de plausibilidade já rejeita isso na detecção |
| Firewall do Windows pedindo liberação | Conexão de **entrada** na 8899 | Permita para rede privada |
| `NAK` / valores de `QPIGS` deslocados | CRC errado | Use `pi30()` do módulo — o init do CRC é `0x0000` |

## Limitações e efeitos colaterais

- **O app oficial fica sem dados enquanto estamos conectados.** O dongle mantém uma
  conexão por vez. Com `--interval 15`, cada dongle fica conectado localmente apenas
  durante uma leitura curta e o coletor aguarda `1,5 s` antes do próximo redirecionamento.
  O app oficial pode mostrar atraso de alguns minutos e volta ao normal depois que o
  dongle reconecta ao servidor da nuvem. Não há proxy permanente nem interceptacao DNS
  neste modo, e o software só usa o redirecionamento temporario exigido pela leitura local.
- **A porta 8899 é exclusiva.** Só um processo pode usá-la.
- `inversor-59` não expõe modo de operação nem tensão de rede — o dongle dele não
  publica esses registradores.
- Em `pi30`, `battery.current_discharge` vem do campo `PPPPP` do `QPIGS` e é reportado
  em ampères inteiros; `current_charge` tem 1 decimal.
- Se o dongle trocar de IP (DHCP), ajuste `devices.json`. Recomendado: reserva de IP
  no roteador.
- O código é **somente leitura**. Nenhum registrador de configuração é escrito.

## Roadmap

- [ ] Modo *proxy*: manter nuvem **e** local simultâneos, redirecionando
      `ess.eybond.com` no DNS do roteador e repassando para o servidor real
      (ideia de [`powmr-eybond-proxy`]).
- [ ] Publicação opcional em MQTT com *discovery* para Home Assistant.
- [ ] Suporte a múltiplos slaves Modbus por dongle.

## Referências

Projetos que apontaram o caminho (todos MIT):

- [`andronick83/powmr-eybond-proxy`] — proxy para loggers Eybond; documenta o formato
  de frame `tid/dev/len/addr/fc` e o significado de `fc=4`.
- [`attilagyurman/anenji-local-modbus`] — gatilho UDP `set>server=` e o mapa de
  registradores Anenji (bateria em 277–281).
- [`HotNoob/PythonProtocolGateway`] — mapa `eg4_3000ehv_v1` (regs 200–344).
- [`jblance/mpp-solar`] — referência do protocolo PI30 (comandos `Q…`).

## Licença

[MIT](LICENSE).

> **Aviso:** projeto não oficial, sem qualquer vínculo com Anenji, Sumry/NextPower,
> Eybond ou DessMonitor. Use por sua conta e risco. A leitura é somente leitura, mas
> convencer o dongle a trocar de servidor interrompe temporariamente o envio para a
> nuvem — avalie se isso é aceitável no seu cenário.

[`powmr-eybond-proxy`]: https://github.com/andronick83/powmr-eybond-proxy
[`anenji-local-modbus`]: https://github.com/attilagyurman/anenji-local-modbus
[`HotNoob/PythonProtocolGateway`]: https://github.com/HotNoob/PythonProtocolGateway
[`jblance/mpp-solar`]: https://github.com/jblance/mpp-solar
