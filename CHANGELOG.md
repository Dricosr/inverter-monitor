# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e versionamento [SemVer](https://semver.org/lang/pt-BR/).

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
