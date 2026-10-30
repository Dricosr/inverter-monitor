# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e versionamento [SemVer](https://semver.org/lang/pt-BR/).

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
