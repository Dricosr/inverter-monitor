# Mapas de registradores — referência para reuso

Este documento existe para quem quer **ler esses inversores por conta própria**, em
qualquer linguagem, sem passar pelo [`inverter_monitor.py`](../inverter_monitor.py).

Os mapas completos estão em [`docs/maps/`](maps) como **JSON legível por máquina** — é a
fonte da verdade. As tabelas abaixo são o mesmo conteúdo em forma de leitura. Para conferir
tudo contra o seu equipamento existe o [`examples/dump_map.py`](../examples/dump_map.py):

```bash
python examples/dump_map.py --ip 192.168.18.59  --map docs/maps/modbus_b_anenji.json
python examples/dump_map.py --ip 192.168.18.33  --map docs/maps/modbus_a_eg4.json
python examples/dump_map.py --ip 192.168.18.106 --map docs/maps/modbus_0925_smg.json
```

## Níveis de evidência

Toda linha das tabelas diz **como** aquele campo foi confirmado. Isso é o mais importante
do documento: evita que alguém use um palpite como se fosse medição.

| Nível | Significado |
| --- | --- |
| **medido** | Lido do equipamento e conferido contra o app do fabricante ou contra uma grandeza física independente (ex.: balanço de energia). |
| **documentado** | Vem de documentação/mapa aberto de terceiros; o valor é coerente no equipamento, mas o significado exato não foi provado aqui. |
| **inferido** | Deduzido por posição ou por comportamento; pode estar errado. Não use em automação. |
| **descartado** | Foi testado e **não** serve para o que parecia. Registrado para ninguém perder tempo de novo. |

## O transporte: dongle Eybond / DessMonitor

Os três inversores usam o mesmo dongle WiFi. Antes de qualquer leitura, é preciso fazer o
dongle apontar para você:

```text
1. UDP para <ip-do-dongle>:58899
   →  set>server=<seu-ip>:8899;
   ←  rsp>server=1;

2. o dongle abre TCP para você na porta 8899 (fixa no firmware)

3. dentro dessa conexão trafegam frames Eybond:

   tid:u16  dev:u16  len:u16  addr:u8  fc:u8  payload
   (big-endian; len = len(payload) + 2)

4. com fc=4 o payload é repassado cru ao inversor (canal transparente):
   ASCII PI30 ou frame Modbus RTU, você escolhe.
```

Cuidados que custaram tempo:

- **Uma conexão por vez.** Enquanto você está conectado, o app do fabricante não recebe
  dados. Feche e aguarde ~1,5 s para o dongle voltar para a nuvem.
- **A porta 8899 é exclusiva.** No Windows, `SO_REUSEADDR` permite dois binds na mesma
  porta e os dois processos brigam pelo dongle. Use `SO_EXCLUSIVEADDRUSE`.
- **Nenhum dongle expõe telemetria por TCP em repouso.** `nmap`, Modbus TCP e as
  integrações tradicionais falham antes de começar.
- **`fc=1` não é confiável para o PN.** Respondeu uma vez e hoje dá timeout. `fc=2` é a
  varredura de redes WiFi do dongle, não identificação.

## Inventário

| Mapa | Equipamento de referência | Transporte | Particularidade |
| --- | --- | --- | --- |
| [`modbus_a_eg4`](maps/modbus_a_eg4.json) | Anenji 6.2 kW | Modbus RTU, slave **1**, fc 3, big-endian | Um bloco único de 45 registradores a partir de 200 |
| [`modbus_b_anenji`](maps/modbus_b_anenji.json) | Anenji 11 kW | Modbus RTU, slave **1**, fc 3, big-endian | Blocos espalhados (252, 277, 342, 389) |
| [`modbus_0925_smg`](maps/modbus_0925_smg.json) | MPS 10.2 kW (`VMII-NXPW5KW`) | Modbus RTU, slave **5**, fc 3, **bytes trocados** | Endereços altos (4501+); é o único jeito de ver o MPPT2 |
| [`pi30_ascii`](maps/pi30_ascii.json) | MPS 10.2 kW | ASCII pela mesma conexão | `QPIGS` só traz o MPPT1; `QPIGS2` responde NAK |

> O mesmo inversor pode falar **dois protocolos**. O MPS 10.2 responde PI30 em ASCII e
> também o mapa 0925 em Modbus. O PI30 tem temperatura e modo; o 0925 tem o MPPT2, as
> correntes reais da bateria e a rede.


## Mapa A — `modbus_a_eg4` (Anenji 6.2 kW)

Mapa estilo EG4 3000EHV / Axpert. Duas leituras: `180+20` para o serial e `200+45` para
todo o resto.

| Reg | Campo | Escala | Unid. | Evidência | Observação |
| --- | --- | --- | --- | --- | --- |
| `186–192` | SN em ASCII | ASCII | — | medido | Devolve 9253123456789B, identico ao SN da nuvem. |
| `200` | Identificador do mapa | — | — | medido | 0xB000. |
| `201` | Modo de trabalho | enum | — | medido | `0` Power On / `1` Standby / `2` Mains / `3` Off-Grid / `4` Bypass / `5` Charging / `6` Fault |
| `202` | Tensao da rede | ÷10 | V | documentado | Zero nesta instalacao (off-grid), igual a nuvem. |
| `203` | Frequencia da rede | ÷100 | Hz | documentado | — |
| `204` | Potencia da rede | — (signed) | W | documentado | — |
| `210` | Tensao de saida | ÷10 | V | medido | Nuvem 229.9 V <-> local 230.0 V. |
| `211` | Corrente de saida | ÷10 (signed) | A | medido | — |
| `212` | Frequencia de saida | ÷100 | Hz | medido | — |
| `213` | Potencia ativa de saida | — (signed) | W | medido | Oscila entre -1 e 1 com carga quase nula; a nuvem mostra 0 W. |
| `214` | Potencia aparente de saida | — (signed) | VA | medido | — |
| `215` | Tensao da bateria | ÷10 (signed) | V | medido | — |
| `216` | Corrente da bateria (alternativa) | ÷10 (signed) | A | documentado | Zero nesta unidade; use 232. |
| `217` | Potencia da bateria | — (signed) | W | documentado | — |
| `219` | Tensao PV | ÷10 (signed) | V | medido | Nuvem 28.4 V <-> local 29.3 V. |
| `220` | Corrente PV | ÷10 (signed) | A | documentado | Zero com o arranjo sem producao. |
| `223` | Potencia PV | — (signed) | W | documentado | — |
| `225` | Carga do inversor | — (signed) | % | medido | — |
| `226` | Temperatura do modulo DC | — (signed) | C | medido | — |
| `227` | Temperatura do inversor | — (signed) | C | medido | — |
| `229` | SOC | — | % | medido | — |
| `232` | Corrente da bateria | ÷10 (signed) | A | medido | Positivo = carregando. Este e o valor usado pelo coletor. |
| `643` | Potencia nominal | — | W | medido | 6200 nesta unidade. |
| `218` | Desconhecido (3776) | — | — | descartado | 377.6 com escala 0.1, mas a nuvem nao tem coluna correspondente e o valor nao acompanha o PV. Provavel ajuste. |

> ⚠️ Este mapa **também responde** no dongle do Anenji 11 kW, mas com tudo zerado. Aceite
> a leitura só se `soc` estiver entre 0 e 100 **e** a tensão da bateria entre 8 e 80 V —
> sem essa checagem o inversor seria detectado como mapa A e reportaria SOC 0 %.
> (Foi exatamente essa a "pegadinha" que motivou a validação de plausibilidade.)


## Mapa B — `modbus_b_anenji` (Anenji 11 kW)

Bateria, PV e temperaturas ficam em blocos separados. São seis leituras por ciclo.

| Reg | Campo | Escala | Unid. | Evidência | Observação |
| --- | --- | --- | --- | --- | --- |
| `186–192` | SN em ASCII | ASCII | — | medido | 2 caracteres por registrador. Devolve 92B32504103913, identico ao SN da nuvem. |
| `200` | Identificador do mapa | — | — | medido | 0xB000 neste modelo; tambem presente no mapa A. |
| `201` | Modo de trabalho | enum | — | medido | `0` Power On / `1` Standby / `2` Mains / `3` Off-Grid / `4` Bypass / `5` Charging / `6` Fault |
| `202` | Tensao da rede | ÷10 | V | documentado | 0 = sem rede (off-grid). |
| `203` | Frequencia da rede | ÷100 | Hz | documentado | — |
| `231` | Temperatura do modulo INV | — (signed) | C | medido | Nuvem 43 C <-> local 44 C. O registrador 343 NAO e esta grandeza. |
| `252` | Corrente de saida | ÷10 (signed) | A | medido | — |
| `253` | Frequencia de saida | ÷100 | Hz | medido | — |
| `254` | Potencia ativa de saida | — (signed) | W | medido | — |
| `255` | Potencia aparente de saida | — (signed) | VA | medido | — |
| `277` | Tensao da bateria | ÷10 | V | medido | — |
| `278` | Corrente da bateria | ÷10 (signed) | A | medido | Negativo = descarregando. |
| `279` | Potencia da bateria | — (signed) | W | medido | — |
| `280` | SOC | — | % | medido | — |
| `281` | Temperatura do modulo DC | — (signed) | C | medido | Nuvem 34 C <-> local 34 C. |
| `302` | Potencia PV total (medida) | — | W | medido | Confere com 353+391 em todas as amostras. |
| `303` | Potencia de carga vinda do PV | — | W | medido | Repete a potencia da bateria (279). |
| `304` | Corrente de carga vinda do PV | ÷10 | A | medido | — |
| `305` | Temperatura do modulo PV | — (signed) | C | medido | Nuvem 39-40 C <-> local 39-41 C. |
| `342` | Tensao de saida | ÷10 | V | medido | O registrador 346 repete o valor. |
| `343` | Temperatura (nao publicada) | — (signed) | C | inferido | Sobe com a carga (47-49 C), mas NAO e a temperatura que o fabricante publica. Lido e descartado. |
| `350` | Carga do inversor | — | % | medido | — |
| `351` | Tensao PV1 | ÷10 | V | medido | — |
| `352` | Corrente PV1 | ÷10 | A | medido | Confirmado por 353 ~= 351 x 352. |
| `353` | Potencia PV1 | — | W | medido | — |
| `389` | Tensao PV2 | ÷10 | V | medido | — |
| `390` | Corrente PV2 | ÷10 | A | medido | Confirmado por 391 ~= 389 x 390. |
| `391` | Potencia PV2 | — | W | medido | — |
| `691` | Potencia nominal | — | W | medido | 11000 nesta unidade. |
| `750` | Desconhecido (~3810) | — | — | descartado | Parecia energia diaria, mas oscila para cima e para baixo (3814 -> 3806 -> 3813). NAO e contador. |

> ⚠️ **Leituras curtas voltam zeradas** neste dongle: `186+7` e `180+13` devolvem tudo
> zero, e só `180+20` (alinhado) traz o serial. Ao adicionar um campo novo, prefira
> blocos grandes e alinhados.


## Mapa 0925 — `modbus_0925_smg` (MPS 10.2 kW)

O mapa que o dongle usa para alimentar a nuvem neste modelo. Foi o que resolveu o MPPT2,
que o PI30 simplesmente não tem.

| Reg | Campo | Escala | Unid. | Evidência | Observação |
| --- | --- | --- | --- | --- | --- |
| `4501` | Estado de trabalho | enum | — | documentado | `3` Invert Mode / Off-Grid |
| `4502` | Tensao da rede | ÷10 | V | documentado | Zero sem rede. |
| `4503` | Frequencia da rede | ÷10 | Hz | documentado | Frequencia da rede (nao a de saida). Zero sem rede. |
| `4504` | Tensao PV1 (MPPT1) | ÷10 | V | medido | Nuvem PV1 43.9 V <-> local 45.3 V. Coincide com o campo 13 do QPIGS. |
| `4505` | Potencia PV1 (MPPT1) | — | W | medido | — |
| `4506` | Tensao da bateria | ÷10 | V | medido | — |
| `4507` | SOC | — | % | medido | — |
| `4508` | Corrente de carga | — | A | medido | CORRETA: o campo 9 do QPIGS subnotifica (2 A contra 7 A medidos). |
| `4509` | Corrente de descarga | — | A | medido | — |
| `4510` | Tensao de saida | ÷10 | V | medido | — |
| `4511` | Frequencia de saida | ÷10 | Hz | medido | — |
| `4512` | Potencia aparente de saida | — | VA | medido | — |
| `4513` | Potencia ativa de saida | — | W | medido | — |
| `4514` | Carga do inversor | — | % | medido | — |
| `4517` | Machine type | — | — | medido | 520 neste modelo; a nuvem mostra o mesmo. |
| `4518` | CPU principal | — | — | medido | 15202 = 00152.02, igual ao QVFW e a nuvem. |
| `4521` | Nominal aparente | — | VA | medido | 10200. |
| `4522` | Nominal ativo | — | W | medido | 10200. |
| `4523` | Nominal AC tensao | — | V | medido | Valor 230 - ajuste nominal, nao medicao. |
| `4524` | Nominal AC corrente | — | A | medido | Valor 44 - ajuste nominal, nao medicao. |
| `4525` | Tensao nominal da bateria | ÷10 | V | documentado | 480 = 48,0 V. |
| `4526` | Nominal de saida (V) | — | V | medido | Valor 230 - ajuste nominal, nao medicao. |
| `4527` | Nominal de saida (Hz) | ÷10 | Hz | documentado | Valor 500 = 50,0 Hz MESMO com a saida em 60 Hz: e ajuste nominal, nao a frequencia real (use 4511). |
| `4528` | Nominal de saida (A) | — | A | medido | Valor 44 - ajuste nominal, nao medicao. |
| `4529` | Codigo de erro | — | — | documentado | 0 em operacao normal. Significado dos bits ainda nao validado. |
| `4530` | Codigo de alarme | — | — | documentado | — |
| `4531–4534` | Serial (codificacao desconhecida) | — | — | inferido | 5535, 5535, 5535, 55 - lembra o 55355535553555 que o QID devolve, mas nenhum dos dois e o SN do fabricante. |
| `4536` | Prioridade de carga | enum | — | documentado | `0` Utility / `1` Solar / `2` Utility or Solar / `3` Solar only. Enum do schema aberto; nao conferido contra a nuvem deste modelo. |
| `4537` | Prioridade de saida | enum | — | documentado | `0` Utility / `1` Solar / `2` SBU / `3` SUB / `4` SUF. Enum do schema aberto; nao conferido contra a nuvem deste modelo. |
| `4539` | Tipo de bateria | enum | — | documentado | `0` AGM / `1` Flooded / `2` User / `3` Li1 / `4` Li2 / `5` Li3 / `6` Li4. Enum do schema aberto; nao conferido contra a nuvem deste modelo. |
| `4541` | Corrente maxima de carga | — | A | medido | 70 A. |
| `4546` | Tensao de absorcao (bulk) | ÷10 | V | medido | 565 = 56,5 V, igual ao QPIRI e a nuvem. |
| `4547` | Tensao de flutuacao (float) | ÷10 | V | medido | 560 = 56,0 V. |
| `4548` | Tensao de corte | ÷10 | V | medido | 480 = 48,0 V. |
| `4563` | Tensao PV2 (MPPT2) | ÷10 | V | medido | O registro que o PI30 nao expoe. Nuvem PV2 270 V <-> local 286-323 V. |
| `4564` | Potencia PV2 (MPPT2) | — | W | medido | Nuvem PV2 509 W <-> local 553-1151 W, acompanhando o sol. |
| `4553` | Desconhecido (5190) | — | — | inferido | 519,0 V com escala 0.1 - provavel tensao do barramento, nao confirmado. |
| `4554–4561` | Bloco desconhecido (4554-4561) | — | — | inferido | 7, 11, 11, 50, 0, 0, 5, 1. Parece contador de energia, mas nao foi decodificado. |
| `4560–4562` | Desconhecido (4560-4562) | — | — | inferido | 5, 1, 0. Nao e corrente do PV2: com 1151 W em 316 V a corrente seria ~3,6 A. |

> ⚠️ **Três armadilhas juntas.** Slave **5** (não 1), endereços **altos** (4501+) e os
> **bytes de cada registrador trocados**. Ler `os endereços baixos` devolve timeout — foi
> por isso que durante muito tempo se concluiu (errado) que esse inversor "não falava
> Modbus". E ler big-endian num registrador trocado devolve `0xC501 = 50433` em vez de
> `453` (45,3 V), o que faz o mapa inteiro parecer lixo.
>
> O bloco **termina em 4564**: pedir 4565+ devolve o mesmo bloco truncado, e um pedido de
> 80 registradores é truncado em 64.


## PI30 — `pi30_ascii` (MPS 10.2 kW)

Protocolo texto da família Voltronic/Axpert, enviado cru pelo canal `fc=4`.

### Enquadramento e CRC

```text
requisição:  <COMANDO><crc:2><\r>
resposta:    (<dados><crc:2><\r>
recusa:      (NAKss\r

CRC = CRC-16/XMODEM com init 0x0000
      + somar 1 em cada byte de CRC igual a 0x28, 0x0D ou 0x0A
```

Errar o init para `0xFFFF` gera `(NAKss\r` — o inversor recusa sem explicar.

### Comandos

Aceitos neste firmware: `QID`, `QMOD`, `QPI`, `QMN`, `QVFW`, `QVFW2`, `QPIRI`, `QDI`,
`QFLAG`, `QPIWS`, `QMCHGCR`, `QMUCHGCR`, `QFS`, `QPIGS`.

Recusados com `NAK`: `QPIRI2`, `QPIGS2`, `QPIGS3`, `QPGS0`, `QPGS1`, `QPI2`, `QSTATUS`,
`QALL`, `QET`, `QLT`, `QBE`, `QPIZ`, `QPIC`, `QOPPT`, `QCVCR`, `QDOP`, `QEY`, `QEM`, `QHID`
— e outras 25 variantes testadas atrás do MPPT2.

### `QPIGS`

| # | Campo | Tipo | Unid. | Exemplo | Evidência | Observação |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Tensao da rede | float | V | `000.0` | medido | — |
| 1 | Frequencia da rede | float | Hz | `00.0` | medido | — |
| 2 | Tensao de saida | float | V | `230.1` | medido | — |
| 3 | Frequencia de saida | float | Hz | `60.0` | medido | — |
| 4 | Potencia aparente | int | VA | `0482` | medido | — |
| 5 | Potencia ativa | int | W | `0300` | medido | — |
| 6 | Carga do inversor | int | % | `005` | medido | — |
| 7 | Tensao do barramento | int | V | `437` | medido | — |
| 8 | Tensao da bateria | float | V | `53.10` | medido | — |
| 9 | Corrente de carga | int | A | `002` | medido | SUBNOTIFICA: com 869 W de PV2 e 417 W de saida reportou 2 A, enquanto o mapa 0925 dizia 7 A. |
| 10 | SOC | int | % | `049` | medido | — |
| 11 | Temperatura do radiador | int | C | `0059` | medido | — |
| 12 | Corrente PV (so MPPT1) | float | A | `00.0` | medido | — |
| 13 | Tensao PV (so MPPT1) | float | V | `046.3` | medido | — |
| 14 | Tensao da bateria no SCC | float | V | `53.10` | medido | — |
| 15 | Corrente de descarga | int | A | `00000` | medido | — |
| 16 | Flags de estado | bits | — | `00010110` | medido | Bits nao decodificados. |
| 17 | Reservado | int | — | `00` | medido | Constante. |
| 18 | Reservado | int | — | `00` | medido | Constante. |
| 19 | Potencia de carga PV (nao confiavel) | int | W | `00000` | descartado | Fica em 00000 mesmo com o inversor carregando a 13 A. Nao use. |
| 20 | Estado do dispositivo | int | — | `010` | medido | Constante 010 nesta unidade. |

> ⚠️ **Os campos 12/13 são apenas o MPPT1.** Este modelo tem dois MPPTs e não implementa
> `QPIGS2`; o segundo só sai pelo [mapa 0925](#mapa-0925--modbus_0925_smg-mps-102-kw).
>
> ⚠️ **O campo 9 subnotifica a corrente de carga.** Numa leitura simultânea o `QPIGS`
> dizia 2 A enquanto o 0925 dizia 7 A e o balanço de energia pedia 8,5 A.
>
> ⚠️ **O campo 19 não serve.** Fica `00000` mesmo com o inversor carregando a 13 A.

### `QPIRI`

| # | Campo | — | Unid. | Exemplo | Evidência | Observação |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Nominal ac voltage | float | V | `230.0` | documentado | — |
| 1 | Nominal ac current | float | A | `44.3` | documentado | — |
| 2 | Nominal output voltage | float | V | `230.0` | documentado | — |
| 3 | Nominal output frequency | float | Hz | `60.0` | documentado | — |
| 4 | Nominal output current | float | A | `44.3` | documentado | — |
| 5 | Nominal apparent power | int | VA | `0200` | documentado | — |
| 6 | Nominal active power | int | W | `0200` | documentado | — |
| 7 | Battery nominal voltage | float | V | `48.0` | documentado | — |
| 8 | Battery recharge voltage | float | V | `48.0` | documentado | — |
| 9 | Battery redischarge voltage | float | V | `48.0` | documentado | — |
| 10 | Battery bulk voltage | float | V | `56.5` | documentado | — |
| 11 | Battery float voltage | float | V | `56.0` | documentado | — |
| 14 | Max charge current | int | A | `070` | documentado | — |

> Os campos de potência nominal saem `0200 0200` neste clone — inúteis. O nominal real
> (10 200 VA/W) está no mapa 0925.
>
> O `QID` devolve `55355535553555`, que **não** é o SN do fabricante
> (`Q0045529822108191005`). Não use como chave de dispositivo.


## Como descobrir um mapa novo

O método que funcionou, na ordem em que vale a pena tentar:

1. **Ataque o PI30 primeiro.** Se o inversor responde ASCII (`QPI` devolve `PI30`),
   comece por `QPIGS` e `QPIRI`. Resolve a maior parte das grandezas, mas costuma parar no
   primeiro MPPT.
2. **Se faltar dado, procure o mapa Modbus que o dongle usa para a nuvem.** Compare a
   lista de colunas do app do fabricante com esquemas abertos (o catálogo do
   [`ha-eybond-local`](https://github.com/groove-max/ha-eybond-local) tem dezenas de
   mapas prontos). Foi assim que o 0925 apareceu.
3. **Varra por faixas grandes e alinhadas.** Leia 40–64 registradores por vez, em passos
   alinhados. Leituras curtas são as que mais falham silenciosamente.
4. **Teste os dois sentidos de byte.** Se o mapa responde mas os valores são absurdos
   (tensão de 50 000 V, SOC de 300), inverta os bytes de cada registrador: é o caso do
   0925 e passa despercebido com facilidade.
5. **Teste slaves 1 a 8.** O padrão é 1, mas o 0925 é 5. Slaves errados dão timeout, não
   erro — o que engana.
6. **Ancore os valores no app do fabricante.** CPU, modelo, nominais e limites de carga
   são os melhores campos de conferência: são estáveis e únicos. Se 12 campos de
   configuração batem, o mapa está certo.
7. **Feche o ciclo com física.** Um mapa pode "bater" e ainda estar errado. Confira o
   balanço: `PV − saída − carga da bateria ≈ perdas` (da ordem de 10 %). No `.59`, o
   registrador 302 só foi aceito como potência PV total porque a soma dos MPPTs (353+391)
   dava o mesmo valor em todas as amostras.
8. **Desconfie de contador que não só cresce.** O registrador 750 do `.59` parecia energia
   diária (≈3810, e a nuvem mostrava 3,89 kWh), mas oscilava para cima **e** para baixo
   entre leituras. Não é contador — está marcado como **descartado** no mapa.
9. **A nuvem não serve de referência de instante.** O dongle atende um cliente por vez:
   enquanto você lê, a nuvem mostra a amostra anterior. Compare estrutura e ordem de
   grandeza, não igualdade.

## Como contribuir com um mapa

1. Edite o JSON em [`docs/maps/`](maps) — endereço, escala, sinal, unidade e
   **`evidence`** honesto.
2. Confira contra o equipamento:

   ```bash
   python examples/dump_map.py --ip <ip> --map docs/maps/<mapa>.json
   ```

3. Se publicar no coletor, rode os testes e atualize
   [PROTOCOL.md](PROTOCOL.md) com a evidência nova.

## Erros comuns

| Sintoma | Causa provável |
| --- | --- |
| `(NAKss` no PI30 | CRC com init `0xFFFF`; ou comando não suportado pelo firmware |
| `(NAKss` intermitente no `QPIGS` | Dongle atendendo nuvem e inversor juntos: repita |
| Timeout em todos os slaves | Endereço errado (teste 4501+ no mapa 0925) ou dongle já conectado a outro cliente |
| Timeout só em alguns registradores | Leitura curta ou fora de alinhamento |
| Valores absurdos com resposta válida | Bytes trocados (mapa 0925) ou escala errada |
| Valores zerados com resposta válida | Bloco não implementado neste modelo, ou leitura curta demais |
| SOC 0 % num inversor que funciona | Mapa A respondendo zerado: valide a plausibilidade |
| `-1 W` de potência de saída | Registrador oscilando em torno de zero com carga nula; a nuvem mostra 0 W |
