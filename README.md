# ⚡ Monitor local dos inversores híbridos (LAN)

![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![Node.js](https://img.shields.io/badge/node.js-20%2B-5FA04E)
![Dependências](https://img.shields.io/badge/depend%C3%AAncias-nenhuma-brightgreen)
![Testes](https://img.shields.io/badge/testes-95%20passando-brightgreen)
![Licença](https://img.shields.io/badge/licen%C3%A7a-MIT-green)
![Plataforma](https://img.shields.io/badge/plataforma-windows%20%7C%20linux%20%7C%20macos-lightgrey)

Leitura **direta pela rede local**, sem nuvem, de inversores híbridos com dongle WiFi da
família **Eybond / DessMonitor** — a mesma dos apps *SmartESS*, *DESS Monitor* e
*Wi-Fi Pro*. Entrega SOC da bateria, tensões, correntes, potências, PV e temperaturas em
JSON, com API HTTP pronta para automação, além de um painel web que executa ações por SOC.

O coletor **não tem dependências externas** (só a biblioteca padrão do Python 3.10+); o
painel depende apenas de `express`.

```text
inversor-59    Off-Grid  SOC 73 %   53,4 V   PV 2.338 W  (MPPT1 1.120 · MPPT2 1.218)
inversor-106   Battery   SOC 52 %   53,4 V   PV 876 W  (MPPT1 0 · MPPT2 876 · 308,6 V)
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
- [Leitura velha não apaga o painel](#leitura-velha-não-apaga-o-painel)
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

Para **reimplementar a leitura em outra linguagem**, use
**[docs/REGISTER-MAPS.md](docs/REGISTER-MAPS.md)**: os mapas completos ficam em
[`docs/maps/`](docs/maps) como JSON legível por máquina, com o nível de evidência de cada
campo (medido, documentado, inferido ou descartado) e o passo a passo de como descobrir um
mapa novo. Para conferir tudo contra o seu próprio equipamento:

```bash
python examples/dump_map.py --ip 192.168.18.59  --map docs/maps/modbus_b_anenji.json
python examples/dump_map.py --ip 192.168.18.106 --map docs/maps/modbus_0925_smg.json
```

## Os três inversores

| Nome | IP | Dongle | Protocolo | Identificação |
| --- | --- | --- | --- | --- |
| `anenji-6k2` | 192.168.18.33 | Espressif | Modbus RTU — mapa **EG4 3000EHV** (200–244) | reg. 643 = **6200 W** nominal |
| `inversor-59` | 192.168.18.59 | Quectel | Modbus RTU — mapa **Anenji/Megarevo** | reg. 691 = **11000 W** nominal |
| `inversor-106` | 192.168.18.106 | Espressif | **PI30 + Modbus 0925** (`QPIGS` + slave 5, 4501+) | `QMN` = `VMII-NXPW5KW`, CPU `00152.02`, nominal 10 200 VA/W |

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

| Grandeza | `modbus_a` (.33) | `modbus_b` (.59) | `pi30_smg` (.106) |
| --- | --- | --- | --- |
| SOC | ✅ | ✅ | ✅ |
| Tensão da bateria | ✅ | ✅ | ✅ |
| Corrente / potência da bateria | ✅ | ✅ | ✅ |
| PV — tensão por MPPT | 1 entrada | ✅ **MPPT1 e MPPT2** | ✅ **MPPT1 e MPPT2** |
| PV — corrente por MPPT | 1 entrada | ✅ **MPPT1 e MPPT2** | MPPT1 direto; MPPT2 derivada |
| PV — potência por MPPT | 1 entrada | ✅ **medida por MPPT** | ✅ **medida por MPPT** |
| Temperatura do inversor | ✅ | ✅ (reg 231) | ✅ |
| Temperatura do painel / módulo DC | ✅ DC | ✅ ambos | — |
| Rede (tensão/frequência) | ✅ | — | ✅ (0925) |
| Serial (SN) lido do aparelho | ✅ | ✅ | — (o `QID` mente) |

Cada entrada PV vira um objeto em **`pv.inputs`** e o painel desenha **um visor por
MPPT**, com o somatório no cabeçalho do bloco. Entrada que o firmware não expõe aparece
como `não exposto` — nunca herda o número da entrada vizinha.

### O caso do MPS 10.2 (`.106`) — dois MPPTs, os dois lidos

Esse inversor tem **dois MPPTs**. O `QPIGS` do PI30 carrega **apenas o MPPT1** e o
firmware responde **NAK** ao `QPIGS2` (idem outras 25 variantes testadas). Durante um
tempo o painel mostrou `MPPT2 não exposto` — corretamente, mas incompleto.

O caminho estava em outro protocolo: **o mesmo dongle fala Modbus RTU com o inversor**
para alimentar a nuvem, no mapa **0925** (slave 5, endereços 4501+, registradores com os
bytes trocados). Dele saem o **PV2** (registrador 4563 = tensão ÷10, 4564 = potência) e
também a corrente real da bateria.

| Fonte | PV1 | PV2 | Total | Corrente de carga |
| --- | --- | --- | --- | --- |
| `QPIGS` puro | 45,3 V / 0 W | não exposto | 0 W | 2 A (subnotifica) |
| `QPIGS` + mapa 0925 | 45,3 V / 0 W | **305–323 V / 570–920 W** | **~880 W** | **7–9 A** |

A energia fecha: 876 W de PV2 − 348 W de saída = 528 W para a bateria ⇒ 9,9 A a 53,4 V,
contra 9 A medidos. O mesmo cálculo com o `QPIGS` dava 3 A — errado.

O painel mostra os dois visores com valores reais e o total soma as duas entradas.

**O canal ASCII deste modelo falha em parte dos ciclos** — o dongle atende a nuvem no
meio da leitura e o inversor responde `(NAKss` ou vazio. Duas defesas:

1. o comando é repetido quando a resposta vem vazia ou em NAK (o transporte entrega isso
   como sucesso, então a checagem é no conteúdo);
2. se ainda assim o ASCII falhar, a leitura segue **só com o mapa 0925** — PV, bateria e
   saída continuam no painel, apenas sem modo, temperatura e barramento. Antes dessas
   duas correções o `.106` aparecia como *offline* em cerca de metade dos ciclos mesmo
   com o Modbus respondendo.

Se o 0925 também não responder, aí sim o leitor volta ao PI30 puro e o MPPT2 aparece como
`não exposto` — nada quebra.

> A nuvem do fabricante **não** serve de referência de instante: o dongle atende um
> cliente por vez, então enquanto o coletor local lê, a nuvem mostra a amostra anterior.
> A descoberta foi validada por estrutura (12 campos idênticos) e por balanço de energia.

## Painel web

`http://127.0.0.1:3071` — Node.js + Express, sem framework de front-end.

O painel é **passivo em relação aos inversores**: não envia UDP aos dongles, não abre a
porta 8899 e não mexe na nuvem. Ele consulta o coletor ao vivo em
`http://127.0.0.1:8080/status` e usa `data/latest.json` apenas como *fallback*, então
nunca se torna um segundo coletor concorrente.

O botão **Atualizar** não relê o que já está em memória: ele pede ao coletor
(`POST /api/refresh` → `POST /refresh` no coletor) que execute um ciclo **agora** e só
então desenha a tela, então o tempo volta a `Há 0 s`. Durante a espera — o ciclo leva de
5 a 30 segundos, dependendo de quantos inversores respondem — o botão mostra
`Atualizando…` e fica desabilitado, para não empilhar requisições no dongle.

> O carimbo `timestamp` marca o **fim** do ciclo, que é quando o dado passa a existir.
> Carimbar o início fazia o painel mostrar "Há 14 s" logo depois de uma leitura
> recém-feita — e, como o ciclo dura quase o mesmo que o intervalo, o número parecia
> dobrar entre uma atualização e a seguinte.

**Visão geral**

- chips no topo: leitura ao vivo/atrasada, tempo desde a última leitura, `2/3 online`,
  inversores sem resposta e falhas de ação — cada um com detalhe no tooltip;
- cartões de resumo (SOC médio, geração solar, potência entregue) somando **apenas**
  quem respondeu;
- um card por inversor com as métricas de operação (potência de saída, carga no
  inversor, temperatura do inversor, temperatura do painel, tensão da bateria, corrente
  de carga, corrente de descarga);
- identificação com **IP, protocolo, PN e SN** (o SN só aparece quando o aparelho o
  informa de verdade);
- **bloco "Entradas PV" com um visor por MPPT** — `MPPT1 765 W · 211,0 V · 3,6 A` e
  `MPPT2 863 W · 214,5 V · 4,0 A` — mais o somatório no cabeçalho do bloco;
- entrada que o firmware esconde aparece tracejada como `não exposto`, com o motivo e o
  balanço DC como piso (`≥`), para o número nunca mentir;
- **valor que não veio neste ciclo fica na tela, em cinza**, com uma nota
  `sem atualização há N s` logo abaixo — ver [leitura velha não apaga o
  painel](#leitura-velha-não-apaga-o-painel);
- barra de bateria colorida por faixa, aviso de bateria baixa abaixo de 30 % e nome
  amigável persistido em `data/dashboard.json`;
- nada é arredondado para "0": ausência de leitura aparece como `—` com o motivo no
  tooltip, e não como zero.

**Ações automáticas**

- regras por ação, cada uma com seu inversor de referência e sua faixa de SOC;
- chip por regra (`Normal`, `Pausado`, `Reduzido`, `Desligado`, `Liberada`, `Conflito`,
  `Falha`, `Desligada`, `Sem leitura`, `Mantida`, `Confirmando`, `Sem leitura confiável`);
- campo **Confirmar por (segundos)** no formulário: `0` age na hora, `120` exige que o
  gatilho se mantenha por 2 minutos;
- estado real dos alvos (fila do Gate, threads do XMRig, CPUQuota do ai-node) e hash
  rate de agora, 1 min e 15 min;
- último resultado de cada regra visível na linha, com o detalhe técnico no tooltip.

### Leitura velha não apaga o painel

Quando um ciclo não traz uma informação, o painel **não troca o número por
`não exposto`** — isso era mentira quando o dado existia e só não foi atualizado agora.
O comportamento padrão, para todas as métricas, todos os MPPTs e todos os inversores:

1. o coletor guarda a última leitura boa de cada inversor (valores **e** o instante de
   cada folha, em `fields_at`);
2. no ciclo seguinte, o que faltou é completado com esse valor e publicado em
   `cache: { at, fields }` — cada folha com o instante real em que foi lida;
3. o painel mostra o valor **em cinza**, com uma nota `sem atualização há N s` logo
   abaixo.

Exemplos reais desse mecanismo:

| Situação | O painel mostra |
| --- | --- |
| `.106` sem resposta | Card inteiro em cinza, `Sem resposta há 4 min · os valores são da última leitura, às 14:27:49`, e uma nota por MPPT |
| `.106` respondeu, mas o mapa 0925 não | MPPT1 branco (leu agora) e MPPT2 cinza com `sem atualização há 40 s` |
| `.59` com o PV2 vindo do cache | `MPPT2` tracejado, valor cinza, idade embaixo; o total do bloco acompanha |

Duas regras para o número não mentir:

- **o total do bloco PV acompanha o que está na tela** — com uma entrada do cache, o
  total do ciclo somaria só as entradas frescas e contradiria os visores, então ele passa
  a ser a soma do que está sendo exibido, marcado como velho junto;
- **os resumos avisam quando incluem leitura antiga** (`inclui MPS 10.2 com a última
  leitura`) e a automação **ignora** SOC vindo do cache: a regra fica em `Leitura velha`
  e nenhuma ação é aplicada com base em dado antigo.

`não exposto` continua existindo, mas só quando é verdade: quando o aparelho nunca
informou aquele campo.

## Automação por SOC

Quatro ações independentes, todas disparadas pelo SOC de **um** inversor escolhido em cada
regra:

| Ação | Aplicada quando o SOC cai | Liberada quando o SOC sobe |
| --- | --- | --- |
| `gate_pause` | `POST /v1/admin/pausar` no Gate (fila de jobs) | `POST /v1/admin/retomar` |
| `ep2_mining_reduce` | XMRig da EP2 reiniciado com menos threads | restaura as threads do perfil |
| `ainode_mining_reduce` | `ainode-mining-mode ai <percentual>` via SSH | `ainode-mining-mode normal` |
| `ainode_power_off` | `systemctl poweroff` no ai-node | religa por **Wake-on-LAN** |

Cada regra tem `activateBelow`, `resumeAbove`, `desiredIntensity` e `confirmSeconds`
próprios, e todos são configuráveis pela interface (validação: 0–100 e
`resumeAbove > activateBelow`).

### Desligar o ai-node (energia)

A única ação que **não** tem volta pelo próprio canal: com a máquina desligada não há SSH.
Por isso ela é a mais conservadora das quatro.

| Peça | Como funciona |
| --- | --- |
| Gatilho | SOC abaixo de `activateBelow` por `confirmSeconds` **seguidos** |
| Antes de desligar | roda `ethtool -s enp8s0 wol g` e **lê de volta**; se não confirmar `Wake-on: g`, **não desliga nada** |
| Desligar | `systemctl poweroff` via SSH; o fim da conexão é o esperado |
| Confirmar | espera a porta 22 fechar (até 120 s) antes de dar a ação como aplicada |
| Religar | 3 pacotes mágicos UDP em broadcast para o MAC `00:e0:27:42:70:5b`, depois espera até 240 s o host voltar |
| Se não voltar | erro explícito: `confira o Wake-on-LAN na BIOS/UEFI` |

> O ai-node também hospeda o Gate. Desligá-lo derruba `/v1/status` e `/v1/mining` junto —
> o painel mostra o Gate como `Sem resposta` enquanto a máquina estiver fora. O
> `gate.service` é `enabled` neste host, então volta sozinho no boot; ele trouxe inclusive
> o estado de pausa (Redis) que estava antes do desligamento.

O armamento do WOL pede `sudo -n ethtool` no host; o desligamento pede `sudo -n
systemctl poweroff`. Confirme que o `ai-node` aceita essas chamadas sem senha antes de
habilitar a regra.

### Janela de confirmação (`confirmSeconds`)

O gatilho não age na primeira leitura. Uma nuvem que passa, um pico de consumo ou um
inversor que pisca não podem desligar uma máquina.

| Fase | Comportamento |
| --- | --- |
| Primeira leitura no gatilho | abre a janela (`pending`) e espera |
| Condição se mantém | conta até `confirmSeconds` e então age |
| Leitura falha ou fica velha no meio | **zera** a contagem; nada é decidido no escuro |
| Condição volta ao normal antes do fim | cancela (a janela do alvo oposto começa do zero) |
| Alvo muda (ligar ↔ desligar) | recomeça a contagem |
| Ação já está no estado pedido | não confirma de novo: apenas realinha (`alinhada`) |
| Comando falhou | espera `errorBackoffSeconds` (120 s) antes de tentar outra vez |

A janela fica em `data/automation-state.json` (`pending: { target, since }`), então um
restart do painel no meio da espera não reinicia a contagem nem a antecipa.

### Ciclo de vida

O executor roda a cada 10 s (`DASHBOARD_POLL_MS`) e segue sempre o mesmo contrato:

| Situação | O que acontece |
| --- | --- |
| SOC abaixo de `activateBelow` | aplica a ação (pausa/reduz/desliga) |
| SOC entre os dois limites | mantém o último alvo (histerese), sem alternar |
| SOC acima de `resumeAbove` | libera (retoma/restaura o máximo/religa) |
| SOC indisponível, **do cache** ou de snapshot velho | não mexe em nada, cancela a confirmação e mantém o estado aplicado |
| host desligado por outra regra (ex.: ai-node) | fica `Bloqueada` — consequência, não falha: nada é tentado e o chip não conta como erro |
| regra desabilitada ou excluída | libera o recurso que ela havia aplicado |
| ação já está no estado desejado | não repete o comando (idempotente) |
| o comando falhou | registra `Falha` naquela regra, com backoff, sem interromper as outras |

O estado fica em `data/automation-state.json` e é hidratado no restart: uma ação aplicada
antes de reiniciar o serviço continua aplicada e é liberada no momento certo.

> **Somente leitura confiável decide.** A automação usa `device.online`, o snapshot do
> coletor (máximo 120 s) e o carimbo de cada campo: um SOC que veio do cache **nunca**
> dispara nada — o painel mostra `Sem leitura confiável` e a regra espera a próxima
> leitura de verdade. Foi essa trava que impediu uma ação com o `.106` piscando em 30/10.

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
ssh ai-node 'sudo -n ethtool enp8s0 | grep Wake-on'                           # WOL armado?

# o que a automação decidiu/aplicou
Invoke-RestMethod http://127.0.0.1:3071/api/dashboard | Select-Object -ExpandProperty execution
```

Testar o desligamento/religamento sem esperar o SOC cair (o `ai-node` vai desligar de
verdade, e o Gate cai junto):

```powershell
# desliga agora, sem passar pela regra
ssh ai-node 'sudo -n ethtool -s enp8s0 wol g; sudo -n ethtool enp8s0 | grep Wake-on; sudo -n systemctl poweroff'

# e religa de outro terminal
$mac = '00-e0-27-42-70-5b'   # 3 pacotes magicos em broadcast
0..2 | ForEach-Object {
  $b = [byte[]](,0xFF * 6) + (([byte[]]($mac -split '-')) * 16)
  (New-Object System.Net.Sockets.UdpClient).Send($b, $b.Length, '192.168.18.255', 9) | Out-Null
}
```

## Quando um inversor fica offline

Um dongle pode sumir da rede (sem energia, DHCP novo, Wi-Fi caído). O sistema continua
útil nesse cenário:

| Camada | Comportamento |
| --- | --- |
| Coleta | Timeout curto (`--connect-timeout`, padrão **10 s**) por dongle: um aparelho morto não trava o ciclo |
| Coleta | Os demais inversores são lidos normalmente no mesmo ciclo |
| Snapshot | `online: false`, `error` com o motivo em português e `last_ok` com a hora da última leitura boa |
| Snapshot | `cache: { at, fields }` devolve o último valor bom de cada campo, com o instante em que foi lido |
| Snapshot | Gravação atômica (`arquivo.tmp` + `os.replace`): a UI nunca lê JSON pela metade |
| Painel | O card continua preenchido, **em cinza**, com `Sem resposta há N s · os valores são da última leitura, às HH:MM:SS` |
| Painel | Chips `2/3 online` e `<nome> sem resposta`, com o motivo no tooltip |
| Resumo | SOC médio e potências incluem o último valor conhecido e o tooltip avisa isso |
| Painel | Snapshot com mais de 120 s marca **todos** os valores como desatualizados e ganha o chip `Coletor fora do ar` |
| Serviço | `InverterMonitorWatchdog` (2 min) reinicia o coletor se a porta 8080 cair ou o snapshot parar |
| Serviço | Ao subir, o coletor recupera o último estado do disco: o painel volta preenchido, em cinza |
| Automação | Sem SOC fresco, nenhuma decisão é tomada: a regra fica `Sem leitura` e nada é liberado nem intensificado às cegas |
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
  { "name": "anenji-6k2",   "ip": "192.168.18.33",  "protocol": "modbus_a", "pn": "Q0048085649157",    "soc_on": 60, "soc_off": 45 },
  { "name": "inversor-59",  "ip": "192.168.18.59",  "protocol": "modbus_b", "pn": "I30000251546403679", "soc_on": 60, "soc_off": 45 },
  { "name": "inversor-106", "ip": "192.168.18.106", "protocol": "pi30_smg", "pn": "Q0045529822108",    "soc_on": 60, "soc_off": 45 }
]
```

`"protocol"` pode ser omitido — nesse caso a detecção automática testa os três (mais
lenta). Os valores em `"name"` viram as chaves do JSON e as rotas da API. Reservar IP
fixo no roteador evita ter de editar o arquivo.

`soc_on`/`soc_off` são **opcionais e independentes das regras do painel**: eles só
publicam um booleano de conveniência (`automation.should_run`) e aparecem no log do
coletor como `-> equipamentos: LIGAR/DESLIGAR`. Servem para quem consome `/status` direto
(ex.: um script que liga/desliga as cargas do escritório). **Nenhuma ação do painel usa
esses valores** — as regras do painel vivem em `data/dashboard.json` e são editáveis na
interface. Se não usar esse gancho, pode apagar as duas chaves.

`"pn"` é opcional e serve apenas para exibição: **nenhum comando local devolve o PN**,
então ele é informado aqui com o mesmo valor que o app do fabricante mostra. O SN, quando
o próprio aparelho o informa, é lido automaticamente (registradores 186–192 no mapa B).

Variáveis de ambiente do painel: `PORT` (3071), `HOST`, `INVERTER_COLLECTOR_URL`,
`INVERTER_SNAPSHOT_FILE`, `INVERTER_DASHBOARD_FILE`, `INVERTER_DEVICES_FILE`,
`INVERTER_COLLECTOR_REFRESH_URL` (padrão: derivado da URL de status),
`INVERTER_STALE_AFTER_SECONDS` (120 — acima disso o snapshot inteiro é "velho"),
`DASHBOARD_POLL_MS` (10000), `GATE_BASE_URL`, `EP2_XMRIG_URL`, `EP2_XMRIG_CONFIG`,
`EP2_XMRIG_TOKEN`, `EP2_MINING_BASE_THREADS` (30), `AUTOMATION_ENABLED` (true),
`AUTOMATION_STATE_FILE`.

Variáveis do ai-node (usadas pela ação `ainode_power_off`):

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `AINODE_HOST` | `ai-node` | alias SSH usado nos comandos |
| `AINODE_ADDRESS` | `192.168.18.150` | usado para saber se a máquina está de pé (porta 22) |
| `AINODE_MAC` | `00:e0:27:42:70:5b` | MAC do Wake-on-LAN |
| `AINODE_IFACE` | `enp8s0` | interface onde o WOL é armado |
| `AINODE_BROADCAST` | `192.168.18.255` | endereço do pacote mágico |
| `AINODE_WOL_PORT` | `9` | porta UDP do pacote mágico |

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
| `POST /refresh` | Executa um ciclo **agora** e devolve o snapshot novo (leva o ciclo inteiro; `GET` também aceito, para conferir no `curl`) |
| `GET /health` | `{"ok": true}`, `200` se o último ciclo rodou há menos de 120 s; senão `503` |

```powershell
$s = Invoke-RestMethod http://localhost:8080/status
$s.devices.'inversor-59'.battery.soc            # 70
$s.devices.'inversor-59'.pv.inputs | Select-Object mppt, voltage, current, power
$s.devices.'inversor-106'.pv.inputs[1].power        # 876
```

```bash
curl -s http://localhost:8080/status/inversor-59 | jq .pv
```

### Painel (porta 3071)

| Rota | Método | Retorno |
| --- | --- | --- |
| `/api/dashboard` | GET | Inversores normalizados, integrações, regras e estado de execução |
| `/api/refresh` | POST | Pede um ciclo novo ao coletor e devolve o dashboard atualizado |
| `/api/devices/<id>` | PUT | Salva o nome exibido (`{ "displayName": "..." }`) |
| `/api/rules` | POST | Cria regra (`id`, `name`, `action`, `sourceDeviceId`, `activateBelow`, `resumeAbove`, `desiredIntensity`, `enabled`) |
| `/api/rules/<id>` | PUT / DELETE | Atualiza ou exclui uma regra |
| `/health` | GET | `{"ok": true, "port": 3071, "automationEnabled": true}` |

`action` aceita `gate_pause`, `ep2_mining_reduce` ou `ainode_mining_reduce`.

Do `/api/dashboard`, além de `devices`, `rules`, `intentions` e `integrations`:

| Campo | Significado |
| --- | --- |
| `snapshotTimestamp` | quando o snapshot foi lido (fim do ciclo do coletor) |
| `snapshotAgeSeconds` | idade do snapshot agora |
| `collectorSource` | `collector_api` (ao vivo) ou `snapshot_file` (coletor fora do ar) |
| `collector.reachable` | `false` quando o painel caiu para o arquivo |
| `collector.staleAfterSeconds` | acima disso o snapshot inteiro é considerado velho (**120 s**) |
| `devices[].snapshotStale` | `true` quando o arquivo todo está velho: **todo** valor é antigo |
| `devices[].stale` | `whole`, `since`, `ageSeconds` e `fields` (caminho → idade em segundos) |

## Formato do JSON

Cada dispositivo é um objeto. Campos com `*` dependem do protocolo.

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `ip` | string | IP do dongle |
| `protocol` | `modbus_a` \| `modbus_b` \| `pi30` | Protocolo detectado/configurado |
| `pn`* | string | PN do aparelho, vindo do `devices.json` (o inversor não o expõe pela LAN) |
| `serial`* | string | SN informado pelo aparelho (`modbus_b`: registradores 186–192; `pi30`: `QID`) |
| `serial_trusted`* | bool | `false` quando o firmware devolve um placeholder (caso do `QID` no `pi30`) |
| `online` | bool | `true` se o ciclo conseguiu ler |
| `error` | string | Presente apenas quando `online = false` |
| `last_ok` | string \| null | ISO-8601 da última leitura boa (também quando `online = true`) |
| `cache` | objeto | Presente quando parte da leitura veio do cache — ver abaixo |
| `cache.at` | string | ISO-8601 da leitura boa de onde os valores vieram |
| `cache.fields` | objeto | `caminho → ISO-8601` de **cada folha** reaproveitada (`battery.soc`, `pv.inputs.1.power`…) |
| `mode` | string \| null | Modo de operação (`Off-Grid`, `Battery`, `Line`, `Standby`…) |
| `status_code`* | int | Código bruto do modo (`modbus_b`), útil para diagnóstico |
| `serial`* | string | Serial informado pelo `QID` (`pi30`) — ver `serial_trusted` |
| `battery.soc` | int | **SOC em %** |
| `battery.voltage` | float | Tensão da bateria (V) |
| `battery.current`* | float | Corrente (A); negativo = descarregando (`modbus_a`/`modbus_b`) |
| `battery.power`* | float | Potência (W); negativo = descarregando |
| `battery.current_charge`* | float | Corrente de carga (A) — só `pi30` |
| `battery.current_discharge`* | float | Corrente de descarga (A) — só `pi30` |
| `battery.current_partial`* | bool | `true` quando o protocolo subnotifica as correntes (não ocorre mais no `.106`) |
| `battery.voltage_scc`* | float | Tensão vista pelo SCC (V) — só `pi30` |
| `battery.temperature`* | int | Temperatura informada pelo protocolo (mapa A); no mapa B use `temperature.dcdc` |
| `pv.voltage` | float \| null | Tensão PV do **MPPT1** (V) |
| `pv.voltage2`* | float | Tensão do **MPPT2** (`modbus_b` e `pi30_smg`) |
| `pv.current`* | float | Corrente PV (A) |
| `pv.power`* | float \| null | Potência PV (W) — medida; no `.59` vem do reg 302, no `.106` é a soma dos MPPTs |
| `pv.power_source`* | string | De onde veio o total (`reg 302 (medido)`, `soma dos MPPT`…) |
| `pv.charging_power`* | float | Potência de carga vinda do PV (W) — reg 303 (`modbus_b`) |
| `pv.charging_current`* | float | Corrente de carga vinda do PV (A) — reg 304 (`modbus_b`) |
| `pv.inputs`* | objeto[] | **Uma entrada por MPPT** com `mppt`, `voltage`, `current`, `power` e `readable` |
| `pv.inputs[].current_source`* | string \| null | Preenchido quando a corrente é derivada (só o MPPT2 do `.106`) |
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

`cache` só aparece quando alguma folha veio de uma leitura anterior — leitura parcial
(uma entrada PV sem resposta) ou inversor inteiro offline. Exemplo de `.106` com o mapa
0925 mudo:

```json
"cache": {
  "at": "2026-10-30T14:30:08-03:00",
  "fields": {
    "pv.inputs.1.voltage": "2026-10-30T14:30:08-03:00",
    "pv.inputs.1.current": "2026-10-30T14:30:08-03:00",
    "pv.inputs.1.power":   "2026-10-30T14:30:08-03:00"
  }
}
```

No painel (`/api/dashboard`) o normalizador transforma isso em idades:

```json
"stale": {
  "whole": false,
  "since": "2026-10-30T14:30:08-03:00",
  "ageSeconds": 40,
  "fields": { "pv.inputs.1.power": 40, "pv.power": 40 }
}
```

`whole: true` significa que o card inteiro veio do cache (inversor sem resposta) **ou**
que o snapshot está velho (`snapshotStale`): quando o coletor para, tudo na tela envelhece
junto e a idade é a do arquivo.

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

> **Por que não aparece janela:** as três tarefas rodam com
> `-Principal … -LogonType S4U -RunLevel Highest`, ou seja, na **sessão 0**
> (não interativa). `-WindowStyle Hidden` **não basta**: um processo de console iniciado
> em sessão interativa abre a janela do `conhost` de qualquer jeito, e a janela do
> `pwsh.exe` fica visível. Se precisar re-registrar uma tarefa, **passe o `-Principal`** —
> sem ele o Agendador assume `Interactive` e a janela volta.

```powershell
# conferir em que sessão cada processo está (0 = invisível)
Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='python.exe' OR Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'inverter|server\.mjs|watchdog' } |
  ForEach-Object { "{0} sessao={1}" -f $_.ProcessId, (Get-Process -Id $_.ProcessId).SessionId }

Get-ScheduledTask -TaskName 'InverterMonitor*' |
  Select-Object TaskName, @{n='LogonType';e={$_.Principal.LogonType}}
```

```powershell
Start-ScheduledTask -TaskName InverterMonitorCollector   # reiniciar após mudança de código
Get-ScheduledTaskInfo -TaskName InverterMonitorCollector | Select-Object LastRunTime, LastTaskResult
```

### Vigia do coletor (`InverterMonitorWatchdog`)

O Agendador só reinicia uma tarefa em caso de **falha** — um processo que morre com
código 0 fica morto. Em 30/10 foi exatamente o que aconteceu: o coletor sumiu às 18:49 e
a leitura parou por 6 minutos. O vigia cobre esse buraco:

```powershell
pwsh -File scripts\watchdog.ps1              # roda uma vez (silencioso se estiver tudo bem)
pwsh -File scripts\watchdog.ps1 -MaxAgeSeconds 300
```

Registrado a cada **2 minutos**, ele reinicia o coletor quando:

| Sintoma | Significado |
| --- | --- |
| porta 8080 não escuta | o processo morreu (inclusive com código 0) |
| snapshot parado há mais de 180 s | o processo vive, mas travou num ciclo (dongle mudo) |

O que aconteceu fica em `data/watchdog.log`; o que o coletor fez fica em
`data/collector.log` (rotativo, 1 MB × 3). Nada é registrado enquanto está tudo bem.

```powershell
Get-Content data\watchdog.log -Tail 10      # reinícios automáticos
Get-Content data\collector.log -Tail 20     # ciclos, erros e encerramentos
```

O coletor também recupera o estado anterior ao subir: `history_from_snapshot()` lê o
`latest.json` e o que estava na tela volta **em cinza**, com a idade, em vez de sumir
enquanto o primeiro ciclo não termina.

**Linux** — equivalente com `systemd` (`Restart=always` já cobre o caso da porta cair; o
`ExecStart` não precisa de vigia):

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
├─ docs/REGISTER-MAPS.md referência dos mapas para reuso em outras linguagens
├─ docs/maps/            os mapas em JSON legível por máquina (fonte da verdade)
├─ src/                  painel Node.js
│  ├─ server.mjs         Express, /health e inicialização da automação
│  ├─ config.mjs         configuração por variáveis de ambiente
│  ├─ domain/            normalização do status, avaliação das regras, helpers
│  ├─ services/          integrações e executores de ação (services/automation/)
│  └─ routes/            API do painel
├─ public/               HTML, CSS, JS e ícone do painel
├─ deploy/               tarefas agendadas e script de threads do XMRig
├─ scripts/watchdog.ps1  reinicia o coletor se a porta 8080 cair ou o snapshot parar
├─ examples/             saída real, uso como biblioteca, PowerShell e dump de mapas
├─ tests/                parsers e poll (Python) e automação (Node)
└─ data/                 estado em tempo de execução (ignorado pelo Git)
```

## Testes

```bash
# parsers, CRC, framing, poll, cache do valor valido e reinicio (75 testes, sem rede)
python tests/test_parsers.py
python tests/test_poll.py

# automacao, integracoes e normalizacao do painel (43 testes)
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
| `Geração solar 0 W` no `.106` de dia | PV1 sem painéis e o MPPT2 zerado | Confira o visor do MPPT2; se ele disser `não exposto`, o mapa 0925 não respondeu |
| `Corrente de carga (parcial)` | Um inversor PI30 sem o mapa 0925 | Esperado nesse caso; com o 0925 o rótulo desaparece |
| `MPPT2 não exposto` no `.106` | Os dois canais falharam e não há leitura anterior | Rode com `-v`; quando existe leitura anterior o painel mostra o valor em cinza com a idade |
| `Leitura atrasada` + `Coletor fora do ar` | O processo do coletor não está respondendo na 8080 | O `InverterMonitorWatchdog` reinicia em até 2 min; se persistir, veja `data/watchdog.log` e `data/collector.log` |
| Card inteiro cinza com `Leitura de ... há N min sem atualizar` | O snapshot está velho: nada foi lido desde aquele horário | Confira o coletor; os valores são os últimos conhecidos, não leituras de agora |
| `encerramento sujo anterior` no `collector.log` | O processo morreu no meio de uma gravação (`.tmp` órfão) | O `.tmp` é removido e o `latest.json` anterior continua válido; o vigia já recolocou o serviço |
| `.106` marcado `offline` sem motivo | NAK ou resposta vazia no ASCII eram tratados como falha | Corrigido na 1.3.2: NAK/vazio são repetidos e o 0925 sozinho mantém o inversor online |
| Valor em cinza com `sem atualização há N s` | O campo não veio neste ciclo e está sendo reaproveitado | Esperado — é o último valor válido; a próxima leitura boa volta a deixá-lo branco |
| Nota com idade grande que não diminui | O campo não volta a ser lido (registrador instável) | Veja `cache.fields` em `/status`; a idade é contada desde a última leitura real daquele campo |
| Regra em `Bloqueada` | O host da ação foi desligado por outra regra | Esperado — volta a agir quando o host religar |
| **Janela do `pwsh.exe` visível** | A tarefa foi registrada como `Interactive` (sessão 1); `-WindowStyle Hidden` não resolve | Re-registre com `-Principal … -LogonType S4U` (ou rode `deploy\install-collector.ps1` de novo) |
| Diálogo não fecha ao clicar `Cancelar` | Corrigido na 1.4.1 (era `submit`, barrado pela validação) | Recarregue com `Ctrl+F5` para pegar o `app.js` novo |
| `bloco 277+29 veio truncado` | O dongle devolveu menos registradores que o pedido | Passageiro na maioria dos casos; a leitura é repetida e, se persistir, o card mostra o último valor em cinza |
| Tempo desde a leitura parecia dobrar | Era o carimbo do início do ciclo | Corrigido na 1.3.1: o `timestamp` marca o fim do ciclo |
| Temperatura `—` | Modelo não expõe aquele sensor | Esperado; o tooltip da métrica explica |
| EP2 volta às threads máximas sozinha | `"watch": true` no `config.json` do XMRig | Use `"watch": false` |
| Regra em `Conflito` | A pausa do Gate foi criada por outra origem | A automação não desfaz pausa alheia; libere manualmente |
| Firewall do Windows pedindo liberação | Conexão de **entrada** na 8899 | Permita para rede privada |
| `NAK` / valores de `QPIGS` deslocados | CRC errado | Use `pi30()` do módulo — o init do CRC é `0x0000` |

## Limitações e efeitos colaterais

- **O app oficial fica sem dados enquanto estamos conectados.** O dongle mantém uma
  conexão por vez. Com `--interval 15`, cada dongle fica conectado localmente apenas
  durante uma leitura curta e o coletor aguarda **1,5 s** antes do próximo  redirecionamento. O app oficial pode atrasar alguns minutos e volta ao normal depois
  que o dongle reconecta à nuvem. Não há proxy permanente neste modo.
- **A porta 8899 é exclusiva.** Só um processo pode usá-la, e o coletor também exige a
  porta HTTP livre: se outra instância já estiver na 8080, a nova encerra em vez de rodar
  em paralelo.
- **O `.106` mistura dois protocolos.** O `QPIGS` só carrega o MPPT1 e subnotifica as
  correntes da bateria; o mapa Modbus **0925** (slave 5, 4501+) traz o MPPT2 e as
  correntes reais. O leitor `pi30_smg` usa os dois e tolera o canal ASCII intermitente:
  NAK e resposta vazia são repetidos e, se persistirem, a leitura segue só com o 0925 —
  modo, temperatura e barramento vêm do cache, em cinza com a idade (ou `—` se nunca
  foram lidos).
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
- [ ] Achar o contador de energia do `.59`: a nuvem mostra 3,89 kWh do dia e 5596 kWh
      acumulados, mas o registrador 750 não serve (varia para cima e para baixo).
- [ ] Publicar os alarmes do `.106`: o `QPIWS` responde e o mapa 0925 tem código de erro
      (4529) e de alarme (4530); falta validar o significado de cada bit.
- [ ] Modo *proxy*: manter nuvem **e** local simultâneos, redirecionando
      `ess.eybond.com` no DNS do roteador e repassando para o servidor real
      (ideia de [`powmr-eybond-proxy`]).
- [ ] Publicação opcional em MQTT com *discovery* para Home Assistant.

## Referências

- [`powmr-eybond-proxy`] — proxy DNS para dongles Eybond.
- [`anenji-local-modbus`] — mapa de registradores de um Anenji específico.
- [`ha-eybond-local`] — integração Home Assistant para estes dongles; o catálogo interno
  de protocolos foi o que revelou o mapa **0925** (slave 5, base 4501) usado no `.106`.
- `mpp-solar` — implementação de referência do PI30 (Voltronic/Axpert).
- Protocolo PI30: comandos `QPIGS`, `QPIRI`, `QMOD` e o CRC-16/XMODEM com correção dos
  bytes `0x28`, `0x0D` e `0x0A`.
- Evidência local × nuvem deste projeto: [docs/PROTOCOL.md](docs/PROTOCOL.md).

[`powmr-eybond-proxy`]: https://github.com/leodeslf/powmr-eybond-proxy
[`anenji-local-modbus`]: https://github.com/leodeslf/anenji-local-modbus
[`ha-eybond-local`]: https://github.com/groove-max/ha-eybond-local

## Licença

MIT — veja [LICENSE](LICENSE).



