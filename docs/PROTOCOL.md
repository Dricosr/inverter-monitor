# Protocolo — notas de engenharia reversa

Documento de apoio ao [`inverter_monitor.py`](../inverter_monitor.py). Registra o que
foi testado, o que funcionou e o que não funcionou, com valores reais capturados.

> Para **usar** os mapas em outro projeto, prefira
> [`REGISTER-MAPS.md`](REGISTER-MAPS.md): lá os mapas estão completos, com o nível de
> evidência de cada campo, e em JSON legível por máquina em [`maps/`](maps). Este
> documento é o diário de como se chegou até eles.

Todos os testes foram feitos na própria rede local, nos três dongles da instalação.

---

## 1. Reconhecimento

| Etapa | Ferramenta | Resultado |
| --- | --- | --- |
| Hosts vivos | ping sweep + ARP de `192.168.18.0/24` | 10 dispositivos |
| Portas TCP | connect scan 1–65535 nos 9 hosts | só `.59` tinha porta aberta (80) |
| UDP discovery | SSDP, mDNS, `48899` (HF-A11), Tuya `6667` | só os Tuya responderam |
| Fabricante | OUI dos MACs | `.33`/`.106` Espressif, `.59` Quectel |

**Conclusão:** nenhum dongle escuta TCP. Eles só fazem *dial-out* para a nuvem. Qualquer
abordagem com `nmap` + Modbus TCP falha antes de começar.

## 2. O gatilho UDP

Os dongles aceitam, na porta **58899/UDP**, um comando de texto puro:

```
→  set>server=<ip>:<porta>;
←  rsp>server=1;\r\n
```

Enviado para o IP do dongle (unicast). O campo `<ip>:<porta>` é para onde ele deve se
conectar. A resposta é imediata e o callback TCP chega em menos de 1 s:

```
$ python -c "..."       # envia o comando
UDP reply ('192.168.18.33', 58899): b'rsp>server=1;'
CONNECTED from ('192.168.18.33', 58262)
```

> Se o dongle estiver reconectando à nuvem (logo após uma sessão anterior), ele pode
> ignorar o primeiro comando. O código reenvia o UDP a cada 3 s até receber o callback.

## 3. Frame Eybond

Formato idêntico para envio e recepção:

```
 0        2        4        6     7     8
 +--------+--------+--------+-----+-----+--------...
 |  tid   |  dev   |  len   |addr | fc  |  payload
 +--------+--------+--------+-----+-----+--------...
   u16 BE   u16 BE   u16 BE   u8    u8
```

| Campo | Significado |
| --- | --- |
| `tid` | Transaction ID. A resposta traz o mesmo `tid`. Use para casar requisição/resposta. |
| `dev` | Varia por firmware; nas respostas aparece `0x0001` ou `0x0102`. Ignorado na leitura. |
| `len` | `len(addr) + len(fc) + len(payload)` — ou seja, `len(payload) + 2`. |
| `addr` | `0xFF` na maioria; nas respostas de erro aparece `0x00`. |
| `fc` | Função. Ver tabela abaixo. |

### Funções (`fc`) observadas

Enviando um payload fixo (a hora UTC atual) e variando o `fc` em `0..20`:

| `fc` | Resposta de `.106` | Interpretação |
| --- | --- | --- |
| 0 | frame vazio | — |
| 1 | `Q0045529822108` (histórico) | PN do coletor — hoje responde **timeout** em qualquer payload testado |
| 2 | `00 31 [Rede_office,100],[…]` | **varredura de redes WiFi** (SSID + RSSI); não identifica o aparelho |
| 3 | `01 0a` | byte de configuração (10) |
| 4 | `01 17` | byte de configuração (23) |
| 5 | `00 15 "ess.eybond.com"` | **domínio da nuvem** (string com prefixo de tamanho) |
| 6 | `01 1e` | byte de configuração (30) |
| 7 / 8 | `01 00` | zero |
| 9 | `01 23` | byte de configuração (35) |
| 10 | `00 1a` | — |
| 11+ | timeout | não implementado |

> Respostas com prefixo `0x00` são string (`<len><bytes>`); com `0x01` são um byte.
> Esses valores parecem períodos de polling e configurações do coletor.

### `fc=4` é o canal transparente

O payload vai cru para o inversor via RS485 e a resposta volta no mesmo `tid`.
Dois tipos de payload são aceitos:

- **ASCII PI30** — ex. `QPIGS` com CRC e `\r`
- **Modbus RTU** — ex. `01 03 00 C8 00 28` + CRC16

## 4. PI30 (ASCII)

A assinatura do PI30 é o enquadramento `( <dados> <CRC16> \r`.

### A armadilha do CRC

O CRC é **CRC-16/XMODEM com inicialização `0x0000`** (não `0xFFFF`), mais a regra
de incrementar em 1 os bytes de CRC iguais a `0x28`, `0x0D` ou `0x0A`.

Errar o init gera `(NAKss\r` — o inversor rejeita o comando sem explicar. Foi o que
aconteceu na primeira tentativa:

```
CRC com init 0xFFFF  → QPIGS A6 A5 0D  → (NAKss\r      ✗
CRC com init 0x0000  → QPIGS B7 A9 0D  → dados           ✓
```

Outro detalhe: uma resposta de NAK tem formato `(` + `NAK` + CRC + `\r`, em que os dois
bytes de CRC (`73 73`) são impressos como `s` `s` — daí o visual `(NAKss\r`.

### Comandos aceitos

Matriz levantada no `.106` (payload de consulta puro, `fc=4`):

| Comando | Resposta observada |
| --- | --- |
| `QPIGS` | `(000.0 00.0 231.3 60.0 1175 0983 013 414 52.20 000 040 0047 00.0 000.0 52.20 00022 00010000 00 00 00000 010<CRC>\r` |
| `QMOD` | `(B<CRC>\r` — `L` line, `B` battery, `S` standby, `F` fault, `P` power on, `H` power saving |
| `QPI` | `(PI30<CRC>\r` — família de protocolo |
| `QMN` | `(VMII-NXPW5KW<CRC>\r` — modelo |
| `QVFW` | `(VERFW:00152.02<CRC>\r` |
| `QVFW2` | `(VERFW2:00000.00<CRC>\r` |
| `QID` | `(55355535553555<CRC>\r` — **não é o serial real**, ver nota abaixo |
| `QPIRI` | `(230.0 44.3 230.0 60.0 44.3 0200 0200 48.0 48.0 48.0 56.5 56.0 2 002 070 0 1 0 1 01 0 0 50.0 0 1 48.0 10 52.0<CRC>\r` |
| `QDI` | `(230.0 50.0 0030 42.0 54.0 56.4 46.0 50 0 0 2 0 0 0 0 0 1 1 1 0 1 0 54.0 0 1<CRC>\r` |
| `QFLAG` | `(EuvyzlDabjkxgd<CRC>\r` |
| `QPIWS` | `(00000100000000000000000000000000<CRC>\r` |
| `QMCHGCR` | `(010 020 030 040 050 060 070 080<CRC>\r` — correntes de carga CC aceitas |
| `QMUCHGCR` | `(002 010 020 030 040 050 060<CRC>\r` |
| `QFS` | `(01 08 03 0398 0200 0002 000.0 00.00 245.9 60.00 000.0 509.0 64.3 055 164<CRC>\r` |

**Não suportados neste firmware** (`(NAKss\r`):

```
QPIRI2  QPIGS2  QPIGS3  QPGS0   QPGS1   QPI2    QSTATUS  QALL   QET   QLT
QBE     QPIZ    QPIC    QOPPT   QCVCR   QDOP    QEY      QEM    QHID
```

> Note que `P005GS` também é NAK. As variantes `P00xGS` de outros OEMs não valem aqui.

O `QPIRI` é a fonte dos limites de carga: bulk **56,5 V**, float **56,0 V**, corte
**48,0 V** e corrente máxima de carga **70 A**. Os campos de potência nominal vêm como
`0200 0200` (200 VA/W) — valor inútil nesse clone; o nominal real de 10 200 VA/W está na
nuvem, não no `QPIRI`.

> **`QID` mente.** O `.106` responde `55355535553555`, mas o fabricante o identifica por
> `Q0045529822108191005` (PN `Q0045529822108`, que é justamente o retorno de `fc=1`).
> Nunca use o `QID` como chave de dispositivo.

> **`QPIWS` é o registro de alarmes** (32 bits, um caractere por bit). Está disponível,
> mas o mapeamento bit a bit ainda não foi validado — por isso o coletor ainda não o
> publica. Especificação em aberto no [roadmap](../README.md#roadmap).

### Campos do `QPIGS`

| # | Campo | Formato | Exemplo | Escala |
| --- | --- | --- | --- | --- |
| 0 | Tensão da rede | `BBB.B` | `000.0` | V |
| 1 | Frequência da rede | `CC.C` | `00.0` | Hz |
| 2 | Tensão de saída | `DDD.D` | `231.3` | V |
| 3 | Frequência de saída | `EE.E` | `60.0` | Hz |
| 4 | Potência aparente | `FFFFF` | `1175` | VA |
| 5 | Potência ativa | `GGGG` | `0983` | W |
| 6 | Carga | `HHH` | `013` | % |
| 7 | Tensão do barramento | `III` | `414` | V |
| 8 | **Tensão da bateria** | `JJ.JJ` | `52.20` | V |
| 9 | Corrente de carga | `KKK` | `000` | A |
| 10 | **SOC** | `LLL` | `040` | % |
| 11 | Temperatura do radiador | `MMMM` | `0047` | °C |
| 12 | Corrente PV | `NN.N` | `00.0` | A |
| 13 | Tensão PV | `OOO.O` | `000.0` | V |
| 14 | Tensão da bateria (SCC) | `PP.PP` | `52.20` | V |
| 15 | Corrente de descarga | `PPPPP` | `00022` | A |
| 16 | Flags de status | `QQQQQQQQ` | `00010000` | bits |

Como o inversor estava em modo bateria (rede `000.0` V), a consistência foi validada por
energia: 983 W de saída a 52,2 V ⇒ ≈ 21 A de descarga — coerente com o campo 15.

### ⚠️ O `QPIGS` do `.106` só traz o **MPPT1** — o MPPT2 vem do mapa 0925

Este inversor tem **dois MPPTs** e o firmware não implementa `QPIGS2` (responde `NAK`).
Os campos 12/13 do `QPIGS` estão corretos, mas descrevem **apenas a entrada 1**.

Confirmado confrontando a leitura local com a nuvem do fabricante **no mesmo minuto**
(30/10, 09:50):

| Fonte | PV1 | PV2 | Total |
| --- | --- | --- | --- |
| `QPIGS` local (campos 13/12) | 47,3 V / `00.0` A → 0 W | não exposto | — |
| App do fabricante | 47,3 V / **0 W** | **256,4 V / 512 W** | **512 W** |

O `.106` está com **um MPPT sem painéis** (o PV1), e é justamente o que o `QPIGS` mostra.
Nada de PI30 resolve: além de `QPIGS2`, outras 25 variantes foram testadas
(`QPIGS0/1/4/A/B`, `QPIG2`, `QPGS2/3/4`, `QPV2`, `QPIGSPV2`, `QPIRI0/3`, `QMOD2`,
`QMCHGCR2`, `PE0/1/2`, `PD0/1`) e **todas** responderam `NAK`.

**A solução não estava no PI30.** O mesmo dongle também fala **Modbus RTU** com o
inversor — é assim que ele alimenta a nuvem. O mapa é o **0925** (família SMG/Megarevo),
descrito na [seção 7](#7-modbus-rtu--mapa-0925-o-mppt2-do-106).

#### A corrente da bateria também era parcial

Confronto pareado (30/10, 10:20, mesmo minuto):

| Fonte | PV2 | Saída | Corrente de carga | Balanço implícito |
| --- | --- | --- | --- | --- |
| `QPIGS` local (campo 9) | não exposto | 319 W | **5,0 A** (≈ 265 W) | 584 W |
| App do fabricante | 1083 W | 331 W | **12 A** (≈ 637 W) | 968 W |

O campo 9 do `QPIGS` **subnotifica** a carga quando o MPPT2 está produzindo. Depois de
descobrir o mapa 0925 isso ficou medido: numa leitura simultânea (30/10, 11:22) o `QPIGS`
dizia `002` A de carga enquanto o 0925 dizia **7 A**, e o balanço (869 W de PV2 − 417 W
de saída) ÷ 53,4 V pedia **8,5 A** — ou seja, o 0925 estava certo e o PI30 errado.

**O que o projeto faz com isso:**

- o `.106` usa o leitor **`pi30_smg`**: `QPIGS` (temperatura, barramento, modo) **mais**
  o bloco 4501+ do mapa 0925;
- publica **`pv.inputs`** com as duas entradas medidas — MPPT2 em `4563` (tensão ÷10) e
  `4564` (potência), sem corrente porque o firmware não guarda esse dado (a nuvem
  também só mostra tensão e potência do PV2);
- `pv.mppt_unreadable` fica vazio e `pv.power` é a soma das duas entradas;
- bateria, saída e carga passam a vir do 0925, que é a fonte da nuvem; o rótulo
  `(parcial)` desaparece e o `pv.dc_balance` passa a fechar com as perdas;
- se o 0925 não responder, o leitor volta ao PI30 puro e a UI marca o MPPT2 como
  `não exposto` — nada quebra.

## 5. Modbus RTU — mapa A (EG4 3000EHV)

Usado por `.33`. Leitura em bloco único de 45 registradores a partir de 200
(`01 03 00 C8 00 2D` + CRC). Registradores relevantes:

| Reg | Campo | Escala |
| --- | --- | --- |
| 201 | Modo de trabalho | 0 Power On, 1 Standby, 2 Mains, 3 Off-Grid, 4 Bypass, 5 Charging, 6 Fault |
| 202 | Tensão da rede | ÷10 V |
| 203 | Frequência da rede | ÷100 Hz |
| 204 | Potência da rede | W (signed) |
| 210 | Tensão de saída | ÷10 V |
| 211 | Corrente de saída | ÷10 A |
| 212 | Frequência de saída | ÷100 Hz |
| 213 | Potência ativa | W (signed) |
| 214 | Potência aparente | VA |
| **215** | **Tensão da bateria** | ÷10 V |
| 216 | Corrente da bateria | ÷10 A |
| 217 | Potência da bateria | W (signed) |
| 219 | Tensão PV | ÷10 V |
| 220 | Corrente PV | ÷10 A |
| 223 | Potência PV | W |
| 225 | Carga | % |
| 226 | Temperatura DCDC | °C |
| 227 | Temperatura do inversor | °C |
| **229** | **SOC** | % |
| 232 | Corrente da bateria | ÷10 A, positivo = carregando |
| 643 | Potência nominal | W (**6200** nesta unidade) |
| **186–192** | **SN em ASCII** (14 caracteres) | 2 chars por registrador | — |

> O SN vem do bloco alinhado `180+20` (regs 186–192), igual ao mapa B: no `.33` a
> leitura devolve `9253123456789B`, o mesmo SN que o app do fabricante mostra.

Captura real (regs 200–239):

```
01 03 50 B0 00 00 03 08 B5 17 6F 00 00 08 FE 00 13 17 6F 00 0F ...
```

## 6. Modbus RTU — mapa B (Anenji)

Usado por `.59`. Leitura em cinco blocos: `200+37` (cabeçalho, modo, rede e
temperatura do módulo INV), `277+29` (bateria, PV total e temperaturas), `252+4`
(saída), `342+12` (saída + PV1) e `389+3` (PV2). Blocos grandes importam: cada
requisição é uma ida e volta pelo dongle.

| Reg | Campo | Escala | Evidência |
| --- | --- | --- | --- |
| 200 | Identificador do mapa (`0xB000` nos dois Anenji) | — | — |
| **201** | **Modo/estado** | enum igual ao mapa A (`3` = Off-Grid) | — |
| 202 | Tensão da rede | ÷10 V (`0` = sem rede) | — |
| 203 | Frequência da rede | ÷100 Hz | — |
| **231** | **Temperatura do módulo INV** | °C | nuvem 43 °C ↔ local 43–44 °C |
| 252 | Corrente de saída | ÷10 A | — |
| 253 | Frequência de saída | ÷100 Hz | — |
| 254 | Potência ativa | W | — |
| 255 | Potência aparente | VA | — |
| **277** | **Tensão da bateria** | ÷10 V | — |
| 278 | Corrente da bateria | ÷10 A (signed; negativo = descarregando) | — |
| 279 | Potência da bateria | W (signed) | 303 repete o valor |
| **280** | **SOC** | % | — |
| 281 | Temperatura do módulo DC | °C | nuvem 34 °C ↔ local 34 °C |
| **302** | **Potência PV total** (os dois MPPTs) | W | 1213 ↔ 353+391 = 1214 |
| **303** | **Potência de carga vinda do PV** | W | igual à potência da bateria (279) |
| **304** | **Corrente de carga vinda do PV** | ÷10 A | 19,5 A ↔ bateria 19,6 A |
| 305 | Temperatura do módulo PV | °C | nuvem 39–40 °C ↔ local 39–41 °C |
| 342 | Tensão de saída | ÷10 V | 346 repete o valor |
| **350** | **Carga do inversor** | % da potência nominal | — |
| 351 | Tensão PV1 | ÷10 V | — |
| 352 | Corrente PV1 | ÷10 A | 353 ≈ 351 × 352 |
| **353** | **Potência PV1** | W | 210 ↔ 169,5 V × 1,2 A |
| 389 | Tensão PV2 | ÷10 V | — |
| 390 | Corrente PV2 | ÷10 A | 391 ≈ 389 × 390 |
| **391** | **Potência PV2** | W | 278 ↔ 186,4 V × 1,4 A |
| **691** | **Potência nominal** | W (`11000` no `.59`) | — |
| **186–192** | **SN em ASCII** (14 caracteres) | 2 chars por registrador | `92B32504103913` = SN da nuvem |

> ⚠️ **Leituras curtas voltam zeradas.** `186+7` e `180+13` respondem tudo zero nesse
> dongle; só blocos maiores e alinhados (`180+20`) devolvem o serial. As leituras de
> produção usam `180+20` justamente por isso.

A potência de cada entrada vem do **registrador medido** (353 e 391) e só cai para
`V × I` se o firmware não informar a potência. O total publicado usa **302** (medido
pelo inversor, e confere com a soma); a soma fica de reserva. `pv.inputs` traz cada
entrada separada, com tensão, corrente e potência todas medidas:

```json
"pv": {
  "power": 1232.0,
  "power_source": "reg 302 (medido)",
  "charging_power": 1042,
  "charging_current": 19.5,
  "inputs": [
    { "mppt": 1, "voltage": 214.4, "current": 2.5, "power": 556.0, "readable": true },
    { "mppt": 2, "voltage": 205.1, "current": 3.3, "power": 691.0, "readable": true }
  ]
}
```

> O registrador **750** (≈ 3810 e variando ±8 entre leituras) **não** é contador de
> energia: deveria só subir. Ficou fora do payload. A energia diária que a nuvem mostra
> (3,89 kWh) não tem registrador identificado neste mapa.

> ⚠️ O registrador **343** (~47–49 °C) varia com a carga, mas **não** é a temperatura
> que o fabricante publica (a nuvem mostrava 43 °C quando ele marcava 48 °C). Ele é
> lido, porém não é publicado: quem manda no campo `temperature.inverter` é o 231.

### Como esses campos foram descobertos

Varredura de leitura pura (`fc=3`) nos registradores 0–719 do `.59`, correlacionando
com os valores já conhecidos: bateria 52,1 V/54 %/-255 W, saída 240,0 V/1,4 A/195 W e
PV 25,9 V. Os blocos encontrados casaram com a leitura instantânea:

```
pares (tensão, corrente, potência) 351/352/353 e 389/390/391
343 = 49–50 °C (sobe com a carga)      350 = 3 com 335 VA de 11 kW
691 = 11000 (nominal, confirma o modelo)
```

O bloco 342–351 **não** tem o mesmo significado no mapa A: no `.33` esses registradores
guardam ajustes (342=40, 343=20, 344=5500), por isso os offsets são tratados por mapa.

### Conferência contra a nuvem do fabricante (30/10, manhã)

Com o app do fabricante aberto no mesmo minuto, os dois lados fecharam:

| Grandeza | Local (Modbus B) | Nuvem |
| --- | --- | --- |
| SOC | 61 % | 61 % |
| Tensão da bateria | 52,6 V | 52,6 V |
| Potência PV total | 442 W (reg 302) | 444 W |
| PV1 / PV2 | 206,3 V · 174 W / 210,0 V · 266 W | 182,5 V · 188 W / 192,0 V · 269 W |
| Temperatura módulo INV | 44 °C (reg 231) | 43 °C |
| Temperatura módulo DC | 34 °C (reg 281) | 34 °C |
| Temperatura PV | 40 °C (reg 305) | 39–40 °C |

As diferenças de PV são de instante (a nuvem grava a cada 5 min); a escala e o
significado de cada registrador ficaram confirmados.

## 7. Modbus RTU — mapa 0925 (o MPPT2 do `.106`)

Descoberto depois de esgotar o PI30. O `.106` **também responde Modbus**, com três
particularidades que escondiam o mapa:

| Item | Mapa B (`.59`) | Mapa 0925 (`.106`) |
| --- | --- | --- |
| Slave | `1` | **`5`** |
| Endereços | baixos (200–700) | **altos (4501–4564)** |
| Ordem dos bytes | big-endian | **little-endian** (bytes trocados) |

Um `01 03 …` ou `05 03 00 C8 …` (endereços baixos) responde **timeout** ou lixo — foi por
isso que a varredura de slaves 0–32 "não achou nada". O endereço que funciona é
`05 03 11 95 00 40` (slave 5, fc 3, 4501, 64 registradores).

> ⚠️ **Bytes trocados.** O valor de cada registrador chega invertido: `4504 = 453`
> (45,3 V) vem no fio como `C5 01`. Ler big-endian devolve `0xC501 = 50433` e o mapa
> inteiro parece lixo. `_modbus_block_le()` faz a troca.

### Registradores mapeados

| Reg | Campo | Escala | Valor observado |
| --- | --- | --- | --- |
| 4501 | Estado de trabalho | enum | 3 |
| **4502 / 4503** | **Tensão / frequência da rede** | ÷10 | 0 / 0 (sem rede) |
| **4504** | **Tensão PV1** | ÷10 | 45,3 V |
| **4505** | **Potência PV1** | W | 0 |
| **4506** | **Tensão da bateria** | ÷10 | 53,1 V |
| **4507** | **SOC** | % | 49 |
| **4508** | **Corrente de carga** | A | 4 |
| 4509 | Corrente de descarga | A | 0 |
| **4510** | **Tensão de saída** | ÷10 | 229,7 V |
| 4511 | Frequência de saída | ÷10 | 60,0 Hz |
| 4512 | Potência aparente | VA | 529 |
| **4513** | **Potência ativa** | W | 321 |
| **4514** | **Carga do inversor** | % | 5 |
| 4517 | Machine type | enum | 520 |
| **4518** | **CPU principal** | — | 15202 |
| 4521 / 4522 | Nominal aparente / ativo | VA / W | 10200 / 10200 |
| 4523 / 4524 | Nominal AC tensão / corrente | V / A | 230 / 44 |
| 4525 | Tensão nominal da bateria | ÷10 | 48,0 V |
| 4526 / 4527 / 4528 | Nominal saída V / Hz / A | — | 230 / 50,0 / 44 |
| 4529 / 4530 | Código de erro / alarme | — | 0 / 0 |
| 4541 | Corrente máxima de carga | A | 70 |
| 4546 / 4547 / 4548 | Bulk / float / corte | ÷10 | 56,5 / 56,0 / 48,0 V |
| **4563** | **Tensão PV2** | ÷10 | 305,1 V |
| **4564** | **Potência PV2** | W | 568 |

O bloco termina em **4564**: pedir 4565+ devolve o mesmo bloco truncado. Não existe
registrador de corrente do PV2 — e a nuvem do fabricante também só mostra
"PV2 input voltage" e "PV2 input power" para este modelo. Por isso a corrente desse
MPPT é a **única** grandeza do painel calculada a partir de duas medidas (`W ÷ V`) e
aparece como `≈` na tela, com o motivo no tooltip.

### Como foi confirmado

O mapa foi localizado pelo equivalente aberto
[`groove-max/ha-eybond-local`](https://github.com/groove-max/ha-eybond-local), cujo
catálogo interno define o protocolo **0925** (slave 5, base 4501) para esta família de
dongles. A validação foi contra o próprio aparelho e contra a nuvem:

1. **Doze campos bateram de imediato**: CPU `15202`, nominal `10200`, bulk `56,5 V`,
   float `56,0 V`, corte `48,0 V`, corrente máxima `70 A`, machine type `520` — todos
   iguais aos da nuvem, o que provou que o mapa era o certo.
2. **O bloco reproduz a lista de colunas da nuvem**, na mesma ordem, e sobravam
   exatamente dois campos (PV2 tensão e potência) que a nuvem mostra e o PI30 não.
3. **4563 é a única tensão na faixa de string PV** (250–330 V) fora do PV1, e 4564 é a
   única potência — e ela acompanha o sol ao longo da manhã
   (553 → 568 → 609 → 636 → 781 → 876 → 916 W).
4. **A energia fecha**: numa leitura simultânea, 876 W de PV2 − 348 W de saída = 528 W
   para a bateria ⇒ 9,9 A a 53,4 V, contra **9 A** informados pelo 0925 (a diferença é
   perda de conversão). O mesmo cálculo com o `QPIGS` dava 3 A — errado.

> A nuvem **não** serve de referência de instante: o dongle atende **um** cliente por
> vez, então enquanto o coletor local está lendo, a nuvem fica com a última amostra.
> Compare sempre a estrutura e a ordem de grandeza, não o número exato.

## 8. Pegadinha: dois mapas, mesmo dongle

O dongle `.59` **também responde** ao bloco 200–244 do mapa A — só que com tudo zero.
Se a detecção automática aceitasse a primeira resposta, ele seria classificado como
`modbus_a` e reportaria SOC 0 %.

Por isso existe a validação de plausibilidade (`_plausible`): SOC entre 0 e 100 **e**
tensão de bateria entre 8 e 80 V. Leitura zerada é rejeitada e o próximo protocolo é
testado.

## 9. Detecção automática

Ordem testada: `modbus_a` → `modbus_b` → `pi30`.

| Dongle | modbus_a | modbus_b | pi30_smg | pi30 | Resultado |
| --- | --- | --- | --- | --- | --- |
| `.33` | ✅ válido | zeros | timeout | NAK | `modbus_a` |
| `.59` | zeros (rejeitado) | ✅ válido | timeout | NAK | `modbus_b` |
| `.106` | timeout | timeout | ✅ válido | válido | `pi30_smg` |

## 10. O que não funcionou

| Tentativa | Resultado |
| --- | --- |
| TCP 8899 direto no dongle | porta fechada |
| Modbus TCP 502 | porta fechada |
| HTTP na porta 80 do `.33`/`.106` | porta fechada |
| HTTP no `.59` | funciona, mas só UI de configuração (`/cjson/system_para.json`, `wlan_ap_list.json`) — sem telemetria |
| Broadcast UDP `HF-A11ASSISTHREAD` em 48899 | sem resposta |
| Varredura de `fc` 11–20 | timeout |
| `QPIGS2`/`QET`/`QLT`/`QGS*`… no `.106` | NAK — a matriz completa está na [seção 4](#comandos-aceitos) |
| 25 variantes de comando atrás do MPPT2 | NAK: `QPIGS0/1/4/A/B`, `QPIG2`, `QPGS2/3/4`, `QPV2`, `QPIGSPV2`, `QPIRI0/3`, `QMOD2`, `QMCHGCR2`, `PE0/1/2`, `PD0/1` |
| Modbus com endereços baixos no `.106` (slaves 0–32, regs 200–700) | timeout — o mapa certo usa **slave 5 e endereços 4501+** ([seção 7](#7-modbus-rtu--mapa-0925-o-mppt2-do-106)) |
| `fc=1` do dongle pedindo o PN | respondeu `Q0045529822108` uma vez; hoje dá timeout com qualquer payload. `fc=2` é a varredura de WiFi |
| `fc=1..10` pedindo tabela de dados | só devolve configuração do coletor, nunca telemetria |

## 11. Reproduzir

```bash
# descobre o protocolo e imprime a leitura
python inverter_monitor.py --probe 192.168.18.106 -v
```

```python
# conversa crua com o dongle
import inverter_monitor as im

link = im.Dongle("192.168.18.106")
print(link.ask(1, b""))                    # PN do coletor
print(link.ask(4, im.pi30(b"QMOD")))       # modo
print(link.ask(4, im.pi30(b"QPIGS")))      # status completo
link.close()
```
