# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [1.3.1] — 2026-10-31

### Corrigido

- **O tempo "Há N s" parecia dobrar a cada atualização.** O carimbo `timestamp` era
  gravado no **início** do ciclo, mas o snapshot só é publicado no fim: com três
  inversores o ciclo leva ~14 s, então uma leitura recém-feita já aparecia como "Há 14 s"
  e, uma atualização depois, como "Há 28 s". Agora o carimbo marca o **fim** do ciclo —
  quando o dado passa a existir — e o contador começa em zero.
- O `last_ok` de cada inversor passou a ser o instante da leitura daquele inversor, em vez
  do carimbo do ciclo.

### Adicionado

- **O botão Atualizar agora força uma leitura de verdade.** `POST /api/refresh` (painel)
  chama `POST /refresh` no coletor, que executa um ciclo na hora e devolve o snapshot
  novo; só então a tela é redesenhada. Antes ele relia o que já estava em memória, então
  o tempo não zerava — o que dava a impressão de botão quebrado.
- O botão mostra `Atualizando…` e fica desabilitado durante o ciclo (5 a 30 s, conforme
  quantos inversores respondem), para não empilhar requisições.
- `run_cycle()` com trava: um refresh manual nunca roda ao mesmo tempo que o ciclo
  agendado, senão os dois brigariam pela porta 8899 do dongle.

## [1.3.0] — 2026-10-31

### Adicionado

- **`docs/REGISTER-MAPS.md`** — referência dos mapas feita para quem vai reimplementar a
  leitura em outra linguagem. Traz o transporte (gatilho UDP, frame Eybond, canal `fc=4`),
  as tabelas completas dos quatro mapas e o **nível de evidência** de cada campo:
  `medido`, `documentado`, `inferido` ou `descartado`.
- **`docs/maps/`** — os mesmos mapas como **JSON legível por máquina**
  (`modbus_a_eg4`, `modbus_b_anenji`, `modbus_0925_smg`, `pi30_ascii`), para uso direto em
  outras ferramentas. É a fonte da verdade; as tabelas do documento saem deles.
- **`examples/dump_map.py`** — lê um mapa JSON e imprime os valores do inversor informado.
  Serve para conferir os mapas contra o próprio equipamento, sem nenhum endereço embutido
  no código.
- Seção **"Como descobrir um mapa novo"** com o método que funcionou, na ordem: PI30
  primeiro, depois o mapa Modbus que o dongle usa para a nuvem, varredura em blocos
  alinhados, os dois sentidos de byte, slaves 1 a 8, e o fechamento por balanço de energia.

### Registrado por ser armadilha

- O registrador **4527** (nominal de saída em Hz) vale `500` = 50,0 Hz **mesmo com a saída
  em 60 Hz**: é ajuste nominal, não medição. Use o 4511.
- Os enums de prioridade (4536/4537) e de tipo de bateria (4539) vêm de esquema aberto e
  **não** foram conferidos contra a nuvem deste modelo.

## [1.2.1] — 2026-10-31

### Alterado

- **O total de PV do `.59` passou a ser lido, não somado.** O registrador **302** é a
  potência PV total medida pelo inversor (confere com 353+391 em todas as amostras) e
  agora é a fonte de `pv.power`; a soma fica só de reserva. `pv.power_source` diz de
  onde veio o número.
- **`pv.charging_power` (303) e `pv.charging_current` (304)** passaram a ser publicados:
  são a potência e a corrente de carga vindas do PV, medidas pelo aparelho.
- **Rede do `.106` vem do mapa 0925** (4502/4503) em vez do PI30.

### Adicionado

- **SN lido do `.33`**: os registradores 186–192 guardam o serial em ASCII
  (`9253123456789B`, o mesmo da nuvem) e o cartão passou a exibir.
- **Visor de MPPT no `.33`**: o mapa A tem uma entrada PV só; antes o cartão caía no
  aviso "não informa quantas entradas PV tem".
- **Corrente do MPPT2 do `.106`**: o mapa 0925 não tem esse registrador (termina em
  4564), então a corrente é derivada de `W ÷ V` e aparece como **`≈`**, com o motivo no
  tooltip. É a única grandeza calculada do painel.

### Investigado e descartado

- Registrador **750** do `.59` (≈3810): parecia energia diária, mas **oscila para cima e
  para baixo** (3814 → 3806 → 3813), então não é contador. Ficou fora do payload; a
  energia diária da nuvem (3,89 kWh) continua sem registrador identificado.

## [1.2.0] — 2026-10-31

### Adicionado

- **O MPPT2 do `.106` agora é lido do próprio aparelho.** O caminho não estava no PI30:
  o mesmo dongle fala **Modbus RTU** com o inversor para alimentar a nuvem, no mapa
  **0925** — slave **5**, endereços **4501+** e registradores com **bytes trocados**.
  Dele saem `4563` (tensão PV2 ÷10) e `4564` (potência PV2 em W), além da corrente real
  da bateria. Novo leitor **`pi30_smg`** (PI30 + 0925) usado pelo `.106`.
- **As correntes da bateria deixaram de ser parciais.** Leitura simultânea (30/10, 11:22)
  mostrou `QPIGS` dizendo 2 A de carga enquanto o 0925 dizia 7 A, com o balanço de
  energia (869 W de PV2 − 417 W de saída) ÷ 53,4 V pedindo 8,5 A: quem estava certo era
  o 0925. Soc, tensão da bateria, correntes, saída e carga do inversor passam a vir dele;
  temperatura, barramento e modo continuam vindo do PI30.
- `pv.inputs`, `pv.voltage2`, `pv.power2` e `pv.mppt_power` ficam completos para os dois
  MPPTs, e o cartão de resumo deixa de mostrar "Geração solar (parcial)".

### Corrigido

- **Fallback silencioso**: se o mapa 0925 não responder num ciclo, o leitor volta ao PI30
  puro e o MPPT2 aparece como `não exposto` em vez de derrubar a leitura.

### Documentação

- `docs/PROTOCOL.md` ganhou a seção **7**, com o mapa 0925 completo, a pegadinha dos
  bytes trocados e o passo a passo da validação (12 campos idênticos aos da nuvem,
  balanço de energia fechando e a série de potências acompanhando o sol).
- Registrado que a nuvem **não** serve de referência de instante: o dongle atende um
  cliente por vez, então a nuvem fica com a última amostra enquanto o coletor lê.

## [1.1.5] — 2026-10-31

### Adicionado

- **PN visível em cada cartão.** O PN é informado em `devices.json` (`"pn"`) e aparece
  na identificação do inversor, com o mesmo valor que o app do fabricante mostra.
  Nenhum comando local devolve o PN: o `fc=1` do dongle, que já respondeu
  `Q0045529822108`, hoje só devolve timeout, e o `fc=2` é a varredura de redes WiFi.
- **SN lido do próprio aparelho no mapa B.** Os registradores 186–192 do `.59` guardam
  o serial em ASCII (`92B32504103913`) — idêntico ao SN da nuvem. O cartão passa a
  mostrar `PN … · SN …`.

### Corrigido

- **O serial do `.106` não é exibido como se fosse verdadeiro.** O `QID` devolve
  `55355535553555`, que não corresponde ao SN do fabricante (`Q0045529822108191005`).
  A API marca `serial_trusted: false` e o cartão omite o SN desses aparelhos.
- **Leituras curtas de Modbus voltam zeradas nesse dongle**: `186+7` e `180+13` retornam
  tudo zero e só `180+20` (alinhado) devolve o bloco do serial. Registrado no código e
  no `PROTOCOL.md`.

## [1.1.4] — 2026-10-31

### Corrigido

- **A UI mostrava um único "Tensão PV", e esse número era do MPPT1.** No `.106` ele
  aparecia como `45,1 V` enquanto o MPPT2 estava com ~302 V — o cartão escondia que
  existia uma segunda entrada gerando. Agora cada entrada PV tem seu próprio visor.
- **O total de geração passou a somar as entradas, não a herdar a primeira.** O `.59`
  mostra `MPPT1 765 W · MPPT2 863 W → 1.628 W`; o resumo do topo usa a mesma soma.

### Adicionado

- **`pv.inputs`: uma entrada por MPPT**, com `mppt`, `voltage`, `current`, `power` e
  `readable`. Entrada que o firmware esconde vem com `readable: false`, os valores em
  `null` e um `reason` — nunca com o número da entrada vizinha.
- **Bloco "Entradas PV" em cada cartão**, com um visor por MPPT (`MPPT1 758 W · 217,7 V ·
  3,4 A`) e o somatório no cabeçalho. Quando falta uma entrada, o cabeçalho marca
  `1/2` e o cartão mostra `não exposto` com o motivo.
- O cartão de resumo virou **"Geração solar (parcial)"** quando algum inversor esconde
  uma entrada, com o tooltip dizendo quantas ficaram de fora.

### Não suportado (documentado)

- **O MPPT2 do `.106` não é legível pela LAN.** Além de `QPIGS2`, foram testadas 25
  variantes (`QPIGS0/1/4/A/B`, `QPIG2`, `QPGS2/3/4`, `QPV2`, `QPIRI0/3`, `QMOD2`,
  `PE0/1/2`, `PD0/1`…) e **todas** responderam `NAK`. O valor de ~302 V só existe no
  canal da nuvem.

## [1.1.3] — 2026-10-31

### Corrigido

- **A temperatura do `.59` estava no registrador errado.** O campo `temperature.inverter`
  lia o registrador 343 (47–49 °C), mas o valor que o fabricante publica é o do
  registrador **231** — com o app do fabricante aberto no mesmo minuto, 43 °C na nuvem
  contra 44 °C no 231 e 48 °C no 343. Agora o coletor lê o 231.
- **A corrente da bateria do `.106` é parcial e agora está rotulada como tal.** Com
  1083 W no MPPT2 e 331 W de saída, o `QPIGS` reportou 5 A de carga enquanto a nuvem
  mostrava 12 A (outra amostra: `000` A contra 2 A). O parser publica
  `battery.current_partial = true`; o card mostra "Carga da bateria (parcial)" e o
  balanço DC passou a ser apresentado como piso (`≥`), porque é calculado com essa
  corrente subnotificada.

### Adicionado

- **Temperatura do módulo PV** (`temperature.pv`, registrador 305) e do módulo DC
  (`temperature.dcdc`, registrador 281), ambas conferidas contra a nuvem. O card ganhou
  a métrica "Temp. PV"; antes essa informação só existia no display do inversor.
- **Potência por MPPT** (`pv.mppt_power`): o coletor passou a ler os registradores de
  potência medidos (353 e 391 em vez de `V × I`) e o card mostra
  "MPPT1 534 W · MPPT2 642 W". As correntes 352/390 deixaram de ser "inferidas": as
  potências confirmam a escala, e o total bate com o registrador 302 (PV total).
- `docs/PROTOCOL.md` ganhou a tabela de conferência local × nuvem do mapa B.

### Documentação

- **`README.md` reescrito** com a estrutura atual: o que cada protocolo entrega (tabela
  honesta por grandeza), o caso do MPS 10.2, o painel, a automação por SOC, o formato do
  JSON e as limitações reais.
- **Matriz real de comandos PI30** no `PROTOCOL.md`. `QPIRI`, `QPIWS`, `QDI`, `QPI`,
  `QFLAG`, `QFS`, `QMCHGCR` e `QMUCHCR` **respondem** — antes o documento os listava como
  `NAK`. A lista de não suportados ficou explícita (19 comandos).
- Registrado que o **`QID` do `.106` não devolve o serial real** (`553…` contra
  `Q0045529822108191005` na nuvem; o PN vem de `fc=1`).
- Registrado que o `QPIRI` é a fonte dos limites de carga (bulk 56,5 V, float 56,0 V,
  corte 48,0 V, 70 A máx.) e que os campos de potência nominal dele vêm zerados nesse
  clone — o nominal de 10 200 VA/W está na nuvem.
- `pyproject.toml` estava em `1.0.0`; alinhado com o resto do projeto.

### Alterado

- **Uma requisição a menos por ciclo no `.59`**: o mapa B passou de seis blocos pequenos
  para cinco maiores (`200+37`, `277+29`, `252+4`, `342+12`, `389+3`).
- `battery.temperature` saiu do payload do mapa B: o registrador 281 é a temperatura do
  módulo DC (nome que o fabricante usa) e publicá-lo com dois nomes era ambíguo.

## [1.1.2] — 2026-10-31

### Corrigido

- **A geração do `.106` não estava errada, o rótulo estava.** Comparando o painel com o
  app do fabricante no mesmo minuto, o `QPIGS` desse modelo reporta **apenas o MPPT1**
  (47 V, sem painéis, 0 W) enquanto a geração real está no **MPPT2** (~256 V, 512 W) — e
  o firmware responde **NAK** ao `QPIGS2`, então a segunda entrada não é legível por
  PI30. O parser agora publica `pv.mppt = 1`, `pv.mppt_count = 2` e
  `pv.mppt_unreadable = [2]`; o card mostra `0 W` com o aviso "apenas o MPPT1 é exposto"
  em vez de sugerir que o inversor não gera.
- **A estimativa por balanço de energia foi removida.** Com os números da nuvem, o
  cálculo dava 573 W contra 512 W reais (9% acima), porque a carga da bateria entra na
  conta mas não sai toda como potência. O balanço continua disponível como diagnóstico
  (`pv.dc_balance`), nunca como geração.
- `pv.power` passou a ser sempre medido. Ausência de corrente PV não vira mais um número
  inventado.

### Adicionado

- Card do inversor com 8 métricas para diagnóstico: potência de saída, geração solar,
  carga no inversor, temperatura, tensão da bateria, corrente de carga, corrente de
  descarga e tensão PV.
- `battery.charge_current`, `battery.discharge_current`, `battery.charge_power` e
  `battery.discharge_power` no payload (campos 10 e 11 do `QPIGS`).
- Linha de balanço DC no card quando a geração não é medida, para comparar com o display.
- Seção "O `QPIGS` do `.106` só traz o MPPT1" em [docs/PROTOCOL.md](docs/PROTOCOL.md)
  com a tabela local × nuvem e as respostas NAK registradas.
- 6 testes cobrindo o schema MPPT e o balanço.

## [1.1.1] — 2026-10-30

### Corrigido

- **`.106` mostrava `0 W` de geração com o inversor gerando.** O `QPIGS` desse modelo
  deixa o campo de corrente PV (12) travado em `00.0`, então `V × I` dava zero. Agora
  `pv.power` fica `null` (não um falso zero). *(Substituído em 1.1.2: o `0 W` é real —
  o `QPIGS` só lê o MPPT1, que está sem painéis.)*
- **Campos ausentes viravam zero no painel.** `Number(null) === 0` fazia `pv.power`,
  `grid.voltage` e `output.current` aparecerem como `0` quando o coletor informava
  `null`. Agora ausente continua ausente e o card mostra `—`.
- Mensagem do ai-node vazava o comando SSH cru (`Command failed: ssh -o ...`) na tela;
  agora é `ai-node nao respondeu a tempo (timeout)`.
- **Inversor offline derrubava o painel.** `automation-state.json` corrompido (todo em
  bytes NUL, resíduo de processo encerrado no meio da escrita) fazia `/api/dashboard`
  responder 500 e a UI ficar vazia. O `JsonStore` agora detecta o arquivo ilegível,
  guarda uma cópia `*.corrupt-<data>` e recomeça do padrão; o snapshot lido em disco
  também passa por um parse tolerante.
- **Um dongle morto atrasava todo o ciclo.** O timeout de conexão era de 25 s fixos,
  então com 1 de 3 inversores offline o ciclo ia de 15 s para 32 s e os outros dois
  apareciam atrasados. Agora o padrão é 10 s, configurável por `--connect-timeout` ou
  por `connect_timeout` em `devices.json`.
- **Snapshot podia ser lido pela metade.** `data/latest.json` passou a ser gravado em
  arquivo temporário com `fsync` + `os.replace`.
- **Card da EP2 mentia quando a automação não sabia do estado.** Ele dizia "Máxima"
  enquanto o minerador rodava reduzido, porque só olhava o registro da automação. Agora
  a contagem real de threads vem de `/2/backends` e o card mostra "Reduzida · 3 de 30".
- Mensagens de rede em inglês (`The operation was aborted due to timeout`) trocadas por
  texto claro em português para Gate, ai-node e XMRig da EP2.
- Ícone decorativo da barra lateral interceptava cliques nos botões de navegação.

### Adicionado

- `last_ok` por inversor no snapshot: quando o aparelho não responde, o painel mostra
  desde quando não há leitura.
- Estados de regra `Sem leitura` e `Mantida` para o caso de o inversor de referência
  estar offline: a ação aplicada continua aplicada e nada é decidido sem SOC.
- Chips de cabeçalho `2/3 online` e `<nome> sem resposta`, com o motivo no tooltip.
- 5 testes Python do ciclo com inversor morto e 6 testes do `JsonStore`/`parseJsonSafe`.

## [1.1.0] — 2026-10-29

### Adicionado

- **Painel web Node.js** na porta 3071: cartões por inversor, integrações ao vivo
  (Gate, EP2 e ai-node) e automação por SOC, com chips de estado em todos os painéis
  e ajuda contextual no formulário de regras.
- **Automação física** com três ações independentes, cada uma com o seu próprio
  inversor de referência, limites de ligar/desligar e intensidade: pausar a fila do
  Gate, reduzir a mineração da EP2 e reduzir a mineração do ai-node.
- Estado persistido por ação (`data/automation-state.json`): último resultado, histerese
  que sobrevive a restart e liberação automática ao desabilitar ou excluir a regra.
- Executores isolados por ação: falha em uma não interrompe as outras.
- Posse da pausa do Gate por `pausedAt`: a automação nunca retoma uma pausa criada por
  outra pessoa ou sistema; registra `conflito` e deixa a fila como está.
- Ícone próprio do aplicativo (`public/inverter-icon.svg`).
- Instalação como tarefa agendada oculta, no boot e no logon
  (`deploy/install-collector.ps1`, `deploy/install-ui.ps1`).
- Testes do painel (16) cobrindo independência das ações, histerese, liberação ao
  desabilitar/excluir, isolamento de falhas, hidratação do estado e conflito de pausa.

### Corrigido

- **`.59` sem modo, carga, temperatura e PV.** O mapa B só lia tensões. Foram descobertos
  e documentados os registradores 201 (modo), 343 (temperatura), 350 (carga),
  351/352 e 389/390 (tensão/corrente PV) e 691 (potência nominal).
- **Potência solar no `.106`.** O PI30 informa tensão e corrente separadas; a potência
  agora é calculada (`V × I`), assim como a potência da bateria pela corrente líquida.
- Leitura do mapa B agrupada em 6 blocos vizinhos, com respiro de 50 ms e retentativa,
  para o dongle não descartar respostas.
- A automação retomava a pausa do Gate a cada ciclo quando a regra estava em histerese.
- Ações aplicadas não eram liberadas ao desabilitar ou excluir a regra.
- A histerese era esquecida quando o serviço reiniciava ou o SOC ficava indisponível,
  podendo liberar recursos sozinha.
- EP2: `--threads=3` casava com `--threads=30` por prefixo e a redução podia não aplicar.
- **Coletores duplicados.** No Windows `SO_REUSEADDR` permite vários binds na mesma
  porta, então três instâncias subiam juntas e disputavam o mesmo dongle, causando
  timeouts intermitentes. A segunda instância agora falha ao abrir a porta e encerra.
- **EP2 voltava ao máximo sozinha.** O XMRig tinha `"watch": true` e recarregava o
  `config.json` a cada hora, trocando o perfil de 3 threads pelo automático (20) mesmo
  com `--threads=3` na linha de comando — e a automação só olhava a linha de comando,
  então reportava "alinhada". O hot reload foi desligado e a verificação passou a usar
  `/2/backends` (threads reais), com correção automática de qualquer deriva.
- Textos da UI com jargão interno, idioma misturado e uma frase incorreta ("nenhuma ação
  é enviada"), além de elementos colados e grids espremidos no celular.

### Alterado

- A automação física deixou de ser bloqueada (`execution.enabled = false`) e passou a
  executar as regras habilitadas.
- README e `docs/PROTOCOL.md` atualizados; `examples/sample-output.json` regravado com
  uma leitura real dos três inversores.

### Notas

- A corrente PV do mapa B (registradores 352/390) foi inferida por adjacência: à noite
  ela vale zero. A potência solar deve ser conferida contra o display do inversor na
  primeira leitura com geração.
- Nenhuma alteração foi feita no código do Gate; a automação usa apenas
  `POST /v1/admin/pausar` e `POST /v1/admin/retomar`.

## [1.0.0] — 2026-10-23

### Adicionado

- Leitura local dos inversores via gatilho UDP (`set>server=`) e callback TCP na
  porta 8899, com framing Eybond e `fc=4` transparente.
- Três leitores: `modbus_a` (mapa EG4 3000EHV, regs 200–344), `modbus_b`
  (mapa Anenji, bateria 277–281) e `pi30` (`QPIGS`/`QMOD`/`QID`).
- Detecção automática de protocolo com validação de plausibilidade — evita aceitar
  um mapa que responde apenas com zeros.
- API HTTP: `/status`, `/status/<nome>` e `/health`.
- Gravação de `data/latest.json` a cada ciclo.
- Histerese opcional de SOC (`soc_on` / `soc_off`) exposta em `automation.should_run`;
  o programa não aciona nada por conta própria.
- Reenvio periódico do comando UDP até o dongle conectar de volta.
- 18 testes offline (CRC, framing e os três parsers) com bytes capturados de campo.
- Documentação do protocolo em `docs/PROTOCOL.md`.

### Notas

- Sem dependências externas; apenas a biblioteca padrão do Python 3.10+.
- Somente leitura: nenhum registrador de configuração é escrito.
