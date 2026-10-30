import { readFile } from 'node:fs/promises';
import { StatusNormalizer } from '../../domain/statusNormalizer.mjs';
import { parseJsonSafe } from '../../domain/jsonSafe.mjs';
import { advanceConfirmation } from '../../domain/confirmationGate.mjs';
import { JsonStore } from '../jsonStore.service.mjs';
import { GateActionExecutor } from './gateActionExecutor.mjs';
import { Ep2MiningActionExecutor } from './ep2MiningActionExecutor.mjs';
import { AiNodeMiningActionExecutor } from './aiNodeMiningActionExecutor.mjs';
import { AiNodePowerActionExecutor } from './aiNodePowerActionExecutor.mjs';

export function createAutomationService(options) {
  return new AutomationService(options);
}

export class AutomationService {
  constructor({
    enabled = true,
    stateFile,
    dashboardFile,
    devicesFile,
    snapshotFile,
    collectorUrl,
    pollMs = 10_000,
    gateUrl,
    ep2BaseThreads = 30,
    ep2XmrigUrl,
    ep2XmrigConfig,
    ep2XmrigToken,
    aiNode = {},
    snapshotStaleAfterSeconds = 120,
    errorBackoffSeconds = 120,
    actionHosts = {},
    executors,
    rulesProvider,
    deviceProvider,
    now = () => Date.now(),
  }) {
    this.enabled = enabled;
    this.dashboardFile = dashboardFile;
    this.devicesFile = devicesFile;
    this.snapshotFile = snapshotFile;
    this.collectorUrl = collectorUrl;
    this.pollMs = pollMs;
    this.snapshotStaleAfterSeconds = snapshotStaleAfterSeconds;
    this.errorBackoffSeconds = errorBackoffSeconds;
    this.actionHosts = actionHosts;
    this.hosts = {};
    this.now = now;
    this.normalizer = new StatusNormalizer();
    this.stateStore = new JsonStore(stateFile, { actions: {}, updatedAt: null });
    this.executors = executors ?? {
      gate_pause: new GateActionExecutor(gateUrl),
      ep2_mining_reduce: new Ep2MiningActionExecutor(ep2BaseThreads, {
        apiUrl: ep2XmrigUrl,
        configPath: ep2XmrigConfig,
        token: ep2XmrigToken,
      }),
      ainode_mining_reduce: new AiNodeMiningActionExecutor(aiNode.host),
      ainode_power_off: new AiNodePowerActionExecutor(aiNode),
    };
    this.rulesProvider = rulesProvider ?? (async () => {
      const settings = JSON.parse(await readFile(this.dashboardFile, 'utf8'));
      return Array.isArray(settings.rules) ? settings.rules : [];
    });
    this.deviceProvider = deviceProvider ?? (() => this.#loadDevices());
    this.status = {};
    this.hydrated = false;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (!this.enabled) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  async getStatus() {
    await this.#hydrate();
    return this.status;
  }

  async tick() {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      await this.#hydrate();
      const [devices, rules] = await Promise.all([this.deviceProvider(), this.rulesProvider()]);
      // Libera primeiro o que ficou orfao: se a regra de energia religou o host neste
      // ciclo, as regras dependentes ja podem agir no mesmo tick.
      await this.#releaseOrphans(rules);
      for (const rule of rules) {
        if (!rule.enabled) continue;
        await this.#applyRule(rule, devices);
      }
      await this.#saveStatus();
    } catch (error) {
      console.error('[automation] ciclo falhou:', error.message);
    } finally {
      this.running = false;
    }
  }

  async #hydrate() {
    if (this.hydrated) return;
    const stored = await this.stateStore.read();
    this.status = stored.actions ?? {};
    // Host desligado por nos continua desligado depois de um restart: sem isso as
    // regras que dependem dele voltariam a tentar e a encher a tela de "Falha".
    this.hosts = stored.hosts ?? {};
    this.hydrated = true;
  }

  async #applyRule(rule, devices) {
    const source = devices.find((device) => device.id === rule.sourceDeviceId);
    const previous = this.status[rule.id] ?? {};
    const reading = this.#reliableSoc(source);

    // Leitura que nao da para confiar cancela a confirmacao em andamento: esperar
    // com dado velho seria esperar por nada. O estado aplicado nao e tocado.
    if (reading.soc == null) {
      return this.#record(rule, {
        mode: previous.mode ?? 'indeterminado',
        soc: null,
        pending: null,
        action: {
          changed: false,
          applied: previous.applied === true,
          owned: previous.owned === true,
          pausedAt: previous.pausedAt ?? null,
          detail: `leitura nao confiavel: ${reading.reason}`,
        },
        outcome: 'sem_leitura',
      });
    }

    const soc = reading.soc;
    const activateBelow = Number(rule.activateBelow);
    const resumeAbove = Number(rule.resumeAbove);
    const hold = previous.mode;
    let target;
    if (soc < activateBelow) target = 'active';
    else if (soc >= resumeAbove) target = 'inactive';
    else target = hold === 'active' ? 'active' : 'inactive';

    const confirmSeconds = Math.max(0, Math.floor(Number(rule.confirmSeconds) || 0));
    // Confirmacao so em transicao. Se o ciclo anterior ja deixou a acao no estado
    // pedido (`alinhada`/`aplicada`), esperar de novo so gera ruido — era o que fazia
    // a regra reabrir a janela a cada 2 minutos com a maquina ja desligada.
    const settled = (previous.outcome === 'aplicada' || previous.outcome === 'alinhada')
      && previous.mode === target
      && previous.applied === (target === 'active');
    const gate = advanceConfirmation({
      target,
      pending: previous.pending ?? null,
      now: this.now(),
      confirmSeconds: settled ? 0 : confirmSeconds,
    });
    if (gate.action === 'wait') {
      return this.#record(rule, {
        mode: target,
        soc,
        pending: gate.pending,
        action: {
          changed: false,
          applied: previous.applied === true,
          owned: previous.owned === true,
          pausedAt: previous.pausedAt ?? null,
          detail: `gatilho ativo ha ${gate.waitedSeconds}s · confirma em ${gate.remainingSeconds}s`,
        },
        outcome: 'confirmando',
      });
    }

    const executor = this.executors[rule.action];
    if (!executor) {
      return this.#record(rule, {
        mode: target,
        soc,
        pending: null,
        action: { changed: false, applied: false, detail: 'Atividade nao suportada' },
        outcome: 'erro',
      });
    }

    // Host desligado por outra regra: nao e falha, e consequencia. Tentar de novo
    // gastaria SSH/HTTP para nada e pintaria a tela de vermelho com a maquina
    // desligada de proposito.
    const host = this.actionHosts[rule.action];
    if (host && rule.action !== 'ainode_power_off' && this.hosts[host]?.down) {
      const by = this.hosts[host].byName ?? this.hosts[host].byRule ?? 'outra regra';
      return this.#record(rule, {
        mode: previous.mode ?? 'indeterminado',
        soc,
        pending: null,
        action: {
          changed: false,
          applied: previous.applied === true,
          owned: previous.owned === true,
          pausedAt: previous.pausedAt ?? null,
          detail: `${host} desligado pela regra "${by}"`,
        },
        outcome: 'bloqueada',
      });
    }

    // Falhou antes? Espera o backoff em vez de martelar o alvo a cada ciclo.
    const backoff = this.#backoffRemaining(previous);
    if (backoff > 0) {
      return this.#record(rule, {
        mode: target,
        soc,
        pending: null,
        action: {
          changed: false,
          applied: previous.applied === true,
          owned: previous.owned === true,
          pausedAt: previous.pausedAt ?? null,
          detail: `tentativa anterior falhou · nova tentativa em ${backoff}s`,
        },
        outcome: 'erro',
        keepFailedAt: true,
      });
    }

    try {
      const action = await executor.apply(target, rule.desiredIntensity, { previous });
      this.#trackHost(rule, host, action);
      this.#record(rule, {
        mode: target,
        soc,
        pending: null,
        action,
        outcome: action.conflict ? 'conflito' : action.changed ? 'aplicada' : 'alinhada',
      });
    } catch (error) {
      console.error(`[automation] ${rule.id}: ${error.message}`);
      this.#record(rule, {
        mode: target,
        soc,
        pending: null,
        action: { changed: false, applied: previous.applied === true, detail: error.message },
        outcome: 'erro',
        failed: true,
      });
    }
  }

  /**
   * O SOC so vale se veio de uma leitura de agora.
   *
   * Antes desta checagem uma leitura de 5 minutos atras (cache do coletor) decidia a
   * automacao — e desligar uma maquina por causa disso seria irreversivel.
   */
  #reliableSoc(device) {
    if (!device) return { soc: null, reason: 'inversor de referencia nao configurado' };
    const soc = Number(device.soc);
    if (!Number.isFinite(soc)) return { soc: null, reason: 'SOC indisponivel' };
    if (device.online === false) return { soc: null, reason: 'inversor sem resposta' };
    if (device.snapshotStale) {
      const age = device.stale?.ageSeconds;
      return { soc: null, reason: `snapshot com ${age == null ? '?' : `${age}s`} de atraso` };
    }
    const staleFields = device.stale?.fields ?? {};
    if (Object.prototype.hasOwnProperty.call(staleFields, 'battery.soc')) {
      return { soc: null, reason: `SOC veio do cache (${staleFields['battery.soc']}s)` };
    }
    return { soc, reason: null };
  }

  /**
   * Marca/limpa o host que a acao de energia acabou de desligar.
   *
   * `applied` do executor de energia significa "desligado": e o que permite as outras
   * regras do mesmo host saberem que nao adianta tentar.
   */
  #trackHost(rule, host, action) {
    if (!host || rule.action !== 'ainode_power_off') return;
    if (action?.applied === true) {
      this.hosts[host] = { down: true, byRule: rule.id, byName: rule.name ?? rule.id };
    } else {
      delete this.hosts[host];
    }
  }

  #backoffRemaining(record) {
    if (!record?.failedAt || !this.errorBackoffSeconds) return 0;
    const failedAt = Date.parse(record.failedAt);
    if (!Number.isFinite(failedAt)) return 0;
    const elapsed = (this.now() - failedAt) / 1000;
    if (elapsed >= this.errorBackoffSeconds) return 0;
    return Math.ceil(this.errorBackoffSeconds - elapsed);
  }

  async #releaseOrphans(rules) {
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    for (const record of Object.values(this.status)) {
      if (record.mode !== 'active' || record.applied !== true) continue;
      const rule = byId.get(record.ruleId);
      if (rule?.enabled) continue;
      await this.#release(record, rule);
    }
  }

  async #release(record, rule) {
    const executor = this.executors[record.action];
    if (!executor) return;
    try {
      const action = await executor.apply('inactive', rule?.desiredIntensity ?? null, { previous: record });
      // Liberar a acao de energia religa o host: as regras dependentes voltam a valer.
      this.#trackHost(record, this.actionHosts[record.action], action);
      record.mode = 'inactive';
      record.soc = null;
      record.applied = false;
      record.pausedAt = null;
      record.detail = { changed: action.changed, detail: `liberada: ${action.detail}` };
      record.outcome = 'liberada';
      record.updatedAt = new Date().toISOString();
      console.log(`[automation] ${record.ruleId}: acao liberada (${action.detail})`);
    } catch (error) {
      record.detail = { changed: false, detail: `falha ao liberar: ${error.message}` };
      record.outcome = 'erro';
      record.updatedAt = new Date().toISOString();
      console.error(`[automation] ${record.ruleId}: falha ao liberar: ${error.message}`);
    }
  }

  async #loadDevices() {
    const [configRaw, snapshotRaw] = await Promise.all([
      readFile(this.devicesFile, 'utf8').catch(() => '[]'),
      this.#loadSnapshot(),
    ]);
    const config = JSON.parse(configRaw);
    // A idade do snapshot entra aqui pela mesma razao que no painel: com o coletor
    // parado, nenhum valor da tela (nem da automacao) e de agora.
    return this.normalizer.normalize(snapshotRaw, config, {
      staleAfterSeconds: this.snapshotStaleAfterSeconds,
    });
  }

  async #loadSnapshot() {
    try {
      const response = await fetch(this.collectorUrl, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch {
      return parseJsonSafe(await readFile(this.snapshotFile, 'utf8').catch(() => '{}'), {});
    }
  }

  #record(rule, { mode, soc, action, outcome, pending = undefined, failed = false, keepFailedAt = false }) {
    const previous = this.status[rule.id] ?? {};
    const record = {
      ruleId: rule.id,
      action: rule.action,
      mode,
      soc,
      applied: action.applied === true,
      owned: action.owned === true,
      pausedAt: action.pausedAt ?? null,
      detail: { changed: action.changed === true, detail: action.detail },
      outcome,
      updatedAt: new Date().toISOString(),
    };
    // `pending` e o estado da janela de confirmacao: vai para o disco para sobreviver
    // a um reinicio do painel no meio da espera.
    if (pending !== undefined) record.pending = pending;
    else if (previous.pending) record.pending = previous.pending;
    if (failed) record.failedAt = new Date(this.now()).toISOString();
    else if (keepFailedAt && previous.failedAt) record.failedAt = previous.failedAt;
    if (outcome === 'aplicada' || outcome === 'alinhada') delete record.failedAt;
    this.status[rule.id] = record;
  }

  async #saveStatus() {
    await this.stateStore.write({
      actions: this.status,
      hosts: this.hosts,
      updatedAt: new Date().toISOString(),
    });
  }
}
