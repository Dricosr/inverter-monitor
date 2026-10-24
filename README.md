# Monitor local dos inversores híbridos (LAN)

> Repositório: <https://github.com/Dricosr/inverter-monitor>

Leitura **direta pela rede local**, sem nuvem, dos três inversores da instalação.
Entrega SOC da bateria, tensão, corrente, potência, PV, carga e temperatura em JSON,
com uma API HTTP pronta para automação.

Sem dependências externas: só Python 3.10+ (biblioteca padrão).

## O que foi descoberto na rede

Varredura da `192.168.18.0/24`. Os três dongles WiFi dos inversores usam a plataforma
**Eybond / DessMonitor** (a mesma dos apps SmartESS / DESS Monitor / Wi-Fi Pro):

| Nome    | IP              | MAC / chip | Protocolo do inversor | Observação |
|---------|-----------------|------------|-----------------------|------------|
| `anenji-6k2`  | 192.168.18.33  | Espressif | Modbus RTU, mapa EG4 3000EHV (regs 200–344) | reg. 643 = 6200 W nominal |
| `inversor-59` | 192.168.18.59  | Quectel   | Modbus RTU, mapa Anenji (bateria em 277–281) | também expõe UI web na porta 80 |
| `inversor-106`| 192.168.18.106 | Espressif | ASCII PI30 (`QPIGS` / `QMOD`) | serial `55355535553555`, FW `00152.02` |

Outros aparelhos vistos (não são inversores): `.1` roteador Huawei, `.5` PC Gigabyte,
`.41` e `.66` dispositivos Tuya, `.150` DUX, `.200` BMC ASRock.

### Como o dongle é "sequestrado" para a LAN

O dongle fica conectado em `ess.eybond.com:502` e **não escuta nenhuma porta TCP**.
Ele aceita, porém, um comando UDP que troca o servidor de destino:

```
UDP  <ip-do-dongle>:58899      "set>server=<ip-deste-PC>:8899;"
                                <- "rsp>server=1;"
```

Em seguida o dongle abre uma conexão TCP **para nós** na porta 8899. Nessa conexão
trafegam frames do formato Eybond:

```
tid:u16  dev:u16  len:u16  addr:u8  fc:u8  payload     (big-endian, len = addr+fc+payload)
```

Com `fc=4` o payload é repassado cru ao inversor (transparente) — é assim que lemos
`QPIGS` (PI30) ou um frame Modbus RTU.

## Uso

```powershell
cd D:\inverter-monitor

# testar um dongle isolado (detecta o protocolo sozinho)
python inverter_monitor.py --probe 192.168.18.33

# um ciclo e sai (bom para cron/agendador)
python inverter_monitor.py --once

# serviço contínuo + API HTTP em :8080
python inverter_monitor.py --interval 10 --http 8080
```

### API HTTP

| Rota | Retorno |
|------|---------|
| `GET /status` | JSON com todos os inversores |
| `GET /status/<nome>` | JSON de um inversor |
| `GET /health` | `200` se o último ciclo rodou há menos de 120 s |

Exemplo de consumo em PowerShell:

```powershell
$s = Invoke-RestMethod http://localhost:8080/status
$s.devices.'inversor-106'.battery.soc
```

E também é gravado `data/latest.json` a cada ciclo (útil para ler de outro processo).

## Automação dos equipamentos do escritório

Em `devices.json` cada inversor aceita `soc_on` / `soc_off`. A saída passa a incluir:

```json
"automation": { "should_run": true, "soc_on": 60, "soc_off": 45, "reason": "histerese" }
```

- SOC ≥ `soc_on` → `should_run = true`
- SOC ≤ `soc_off` → `should_run = false`
- entre os dois → mantém o estado anterior (histerese, evita liga/desliga oscilando)

Basta o seu script/Node-RED/Home Assistant ler `should_run` e acionar o relé.

## O que esperar dos dados

Leituras reais desta instalação (23/10/2026, 21h):

```json
"anenji-6k2":  { "mode": "Off-Grid", "battery": { "soc": 49, "voltage": 53.1 },
                 "output": { "voltage": 230.0, "frequency": 59.99 },
                 "grid": { "voltage": 222.9, "frequency": 59.99 }, "load_percent": 1 }

"inversor-59": { "battery": { "soc": 54, "voltage": 52.1, "current": -4.2, "power": -218 },
                 "output": { "voltage": 240.0, "active_power": 185 },
                 "pv": { "voltage": 33.8, "voltage2": 33.1 } }

"inversor-106":{ "mode": "Battery", "battery": { "soc": 40, "voltage": 52.2 },
                 "output": { "voltage": 229.7, "apparent_power": 1103 },
                 "load_percent": 12, "temperature": { "inverter": 48 } }
```

## Efeito colateral importante

Enquanto o dongle está conectado a este PC, ele **não** está falando com a nuvem —
o app oficial (SmartESS/DESS Monitor) mostra dados atrasados nesse intervalo.
Com `--interval 10` o dongle fica "preso" ~3 s a cada 10 s. Para dar mais folga ao app,
aumente para `--interval 30` ou `--interval 60`.

Se quiser as duas coisas ao mesmo tempo (nuvem **e** local 24 h), o caminho é um
**proxy**: redirecionar `ess.eybond.com` para este PC no DNS do roteador e repassar
para a nuvem real, intercalando as leituras locais. É o que o projeto
[`andronick83/powmr-eybond-proxy`](https://github.com/andronick83/powmr-eybond-proxy)
faz — dá para adaptar a partir daqui.

## Rodar como serviço no Windows

Tarefa agendada no boot (executa mesmo sem sessão aberta):

```powershell
$py = (Get-Command python).Source
schtasks /Create /TN "InverterMonitor" /SC ONSTART /RU SYSTEM /RL HIGHEST `
  /TR "\"$py\" \"D:\inverter-monitor\inverter_monitor.py\" --interval 30 --http 8080"
```

Remover: `schtasks /Delete /TN "InverterMonitor" /F`

## Limitações conhecidas

- A porta TCP **8899** é fixa no firmware e só um processo pode usá-la — não rode duas instâncias.
- O Windows Firewall pode pedir liberação na primeira execução (conexão de entrada na 8899).
- `inversor-59` não informa modo de operação nem tensão de rede; o dongle dele não expõe esses registradores.
- Em `inversor-106` (PI30), `battery.current_discharge` vem no campo `PPPPP` do `QPIGS`
  e é reportado em ampères inteiros; `current_charge` é em ampères (1 decimal).
- Se o dongle trocar de IP (DHCP), ajuste `devices.json`. Recomendo reservar IP fixo no roteador.
