import { readFile } from 'node:fs/promises';
import { StatusNormalizer } from '../../domain/statusNormalizer.mjs';
import { parseJsonSafe } from '../../domain/jsonSafe.mjs';
import { JsonStore } from '../jsonStore.service.mjs';
import { GateActionExecutor } from './gateActionExecutor.mjs';
import { Ep2MiningActionExecutor } from './ep2MiningActionExecutor.mjs';
import { AiNodeMiningActionExecutor } from './aiNodeMiningActionExecutor.mjs';

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
    executors,
    rulesProvider,
    deviceProvider,
  }) {
    this.enabled = enabled;
    this.dashboardFile = dashboardFile;
    this.devicesFile = devicesFile;
    this.snapshotFile = snapshotFile;
    this.collectorUrl = collectorUrl;
    this.pollMs = pollMs;
    this.normalizer = new StatusNormalizer();
    this.stateStore = new JsonStore(stateFile, { actions: {}, updatedAt: null });
    this.executors = executors ?? {
      gate_pause: new GateActionExecutor(gateUrl),
      ep2_mining_reduce: new Ep2MiningActionExecutor(ep2BaseThreads, {
        apiUrl: ep2XmrigUrl,
        configPath: ep2XmrigConfig,
        token: ep2XmrigToken,
      }),
      ainode_mining_reduce: new AiNodeMiningActionExecutor(),
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
      for (const rule of rules) {
        if (!rule.enabled) continue;
        await this.#applyRule(rule, devices);
      }
      await this.#releaseOrphans(rules);
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
    this.hydrated = true;
  }

  async #applyRule(rule, devices) {
    const source = devices.find((device) => device.id === rule.sourceDeviceId);
    const soc = Number(source?.soc);
    if (!Number.isFinite(soc)) {
      return this.#record(rule, {
        mode: this.status[rule.id]?.mode ?? 'indeterminado',
        soc: null,
        action: { changed: false, applied: this.status[rule.id]?.applied === true, detail: 'SOC de referencia indisponivel' },
        outcome: 'indeterminada',
      });
    }

    const activateBelow = Number(rule.activateBelow);
    const resumeAbove = Number(rule.resumeAbove);
    const hold = this.status[rule.id]?.mode;
    let target;
    if (soc < activateBelow) target = 'active';
    else if (soc >= resumeAbove) target = 'inactive';
    else target = hold === 'active' ? 'active' : 'inactive';

    const executor = this.executors[rule.action];
    if (!executor) {
      return this.#record(rule, {
        mode: target,
        soc,
        action: { changed: false, applied: false, detail: 'Atividade nao suportada' },
        outcome: 'erro',
      });
    }

    try {
      const action = await executor.apply(target, rule.desiredIntensity, { previous: this.status[rule.id] });
      this.#record(rule, {
        mode: target,
        soc,
        action,
        outcome: action.conflict ? 'conflito' : action.changed ? 'aplicada' : 'alinhada',
      });
    } catch (error) {
      console.error(`[automation] ${rule.id}: ${error.message}`);
      this.#record(rule, {
        mode: target,
        soc,
        action: { changed: false, applied: false, detail: error.message },
        outcome: 'erro',
      });
    }
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
    return this.normalizer.normalize(snapshotRaw, config);
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

  #record(rule, { mode, soc, action, outcome }) {
    this.status[rule.id] = {
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
  }

  async #saveStatus() {
    await this.stateStore.write({
      actions: this.status,
      updatedAt: new Date().toISOString(),
    });
  }
}
