# Protocolo — notas de engenharia reversa

Documento de apoio ao [`inverter_monitor.py`](../inverter_monitor.py). Registra o que
foi testado, o que funcionou e o que não funcionou, com valores reais capturados.

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
| 1 | `Q0045529822108` | **PN do coletor** — é o mesmo PN que a nuvem usa para identificar a unidade (SN `Q0045529822108191005`) |
| 2 | `01 1a` | byte de configuração (26) |
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

### ⚠️ O `QPIGS` do `.106` só traz o **MPPT1** — a geração está no MPPT2

Este inversor tem **dois MPPTs** e o firmware não implementa `QPIGS2` (responde `NAK`).
Os campos 12/13 do `QPIGS` estão corretos, mas descrevem **apenas a entrada 1**.

Confirmado confrontando a leitura local com a nuvem do fabricante **no mesmo minuto**
(30/10, 09:50):

| Fonte | PV1 | PV2 | Total |
| --- | --- | --- | --- |
| `QPIGS` local (campos 13/12) | 47,3 V / `00.0` A → 0 W | não exposto | — |
| App do fabricante | 47,3 V / **0 W** | **256,4 V / 512 W** | **512 W** |

O `.106` está com **um MPPT sem painéis** (o PV1), e é justamente o que o `QPIGS` mostra.
A geração real (PV2, ~256 V) não sai por nenhum comando PI30 aceito por esta unidade:

```
QPIGS2  -> NAK      QPGS0 -> NAK     QET  -> NAK     QBE -> NAK
QPIGS3  -> NAK      QPGS1 -> NAK     QLT  -> NAK     QPIZ -> NAK
```

Nenhum campo sobrando da resposta carrega o PV2: 17–20 (`00 00 00000 010`) são constantes
e o dongle **não** envia telemetria espontânea (0 bytes em 25 s de escuta).

#### A corrente da bateria também é parcial

Confronto pareado (30/10, 10:20, mesmo minuto):

| Fonte | PV2 | Saída | Corrente de carga | Balanço implícito |
| --- | --- | --- | --- | --- |
| `QPIGS` local (campo 9) | não exposto | 319 W | **5,0 A** (≈ 265 W) | 584 W |
| App do fabricante | 1083 W | 331 W | **12 A** (≈ 637 W) | 968 W |

Como o PV2 entrega ~1083 W e a saída consome 331 W, sobram ~750 W para a bateria:
quem está certo é a nuvem. O campo 9 do `QPIGS` **subnotifica** a carga quando o MPPT2
está produzindo (noutra amostra: `000` A local contra 2 A na nuvem). Por isso o coletor
publica `battery.current_partial = true` e o painel mostra "Carga da bateria (parcial)".

Consequência: o balanço DC sai **por baixo** nesse inversor — ele é um piso
(`balanço DC ≥ N W`), não um valor fechado.

**O que o projeto faz com isso:**

- publica `pv.mppt = 1`, `pv.mppt_count = 2` e `pv.mppt_unreadable = [2]`;
- publica **`pv.inputs`** com uma entrada por MPPT: a entrada 1 traz
  `voltage`/`current`/`power` medidos e a entrada 2 vem
  `{"readable": false, "voltage": null, "current": null, "power": null, "reason": "..."}`;
- `pv.voltage`, `pv.current` e `pv.power` continuam existindo e descrevem **o MPPT1** —
  verdadeiros, mas não são a geração total;
- o painel desenha **um visor por MPPT** e mostra a entrada 2 como `não exposto`, em vez
  de repetir o valor da entrada 1 (era o que fazia o cartão mentir com `45,1 V`);
- publica `pv.dc_balance` = saída + (carga − descarga) × tensão da bateria, que é uma
  grandeza **medida** no lado DC (diagnóstico, **não** é a potência de entrada PV);
- o balanço aparece como piso (`≥`), para o usuário comparar com o display.

> Por que não publicar o balanço como "geração": com os números da nuvem acima o balanço
> dá 573 W (415 W de saída + 158 W de carga) contra 512 W de PV real — ou seja, ele
> **superestima** por causa das perdas de conversão mal contabilizadas. Um número errado
> com aparência de medido é pior do que um traço honesto.

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
| **302** | **Potência PV total** (os dois MPPTs) | W | 442 ↔ 353+391 = 440 |
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

A potência PV vem do **registrador medido** (353 e 391) e cai para `V × I` só quando
o firmware não informa a potência. O total publicado é a soma das duas entradas, e
`pv.inputs` traz cada entrada separada:

```json
"pv": {
  "power": 1628.0,
  "inputs": [
    { "mppt": 1, "voltage": 211.0, "current": 3.6, "power": 765.0, "readable": true },
    { "mppt": 2, "voltage": 214.5, "current": 4.0, "power": 863.0, "readable": true }
  ]
}
```

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

## 7. Pegadinha: dois mapas, mesmo dongle

O dongle `.59` **também responde** ao bloco 200–244 do mapa A — só que com tudo zero.
Se a detecção automática aceitasse a primeira resposta, ele seria classificado como
`modbus_a` e reportaria SOC 0 %.

Por isso existe a validação de plausibilidade (`_plausible`): SOC entre 0 e 100 **e**
tensão de bateria entre 8 e 80 V. Leitura zerada é rejeitada e o próximo protocolo é
testado.

## 8. Detecção automática

Ordem testada: `modbus_a` → `modbus_b` → `pi30`.

| Dongle | modbus_a | modbus_b | pi30 | Resultado |
| --- | --- | --- | --- | --- |
| `.33` | ✅ válido | zeros | NAK | `modbus_a` |
| `.59` | zeros (rejeitado) | ✅ válido | NAK | `modbus_b` |
| `.106` | timeout | timeout | ✅ válido | `pi30` |

## 9. O que não funcionou

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
| Slaves Modbus 0–32 no `.106` | timeout (o inversor não fala Modbus) |
| `fc=1..10` pedindo tabela de dados | só devolve configuração do coletor, nunca telemetria |

## 10. Reproduzir

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
