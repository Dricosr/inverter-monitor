import { readFile } from 'node:fs/promises';
import { StatusNormalizer } from '../../domain/statusNormalizer.mjs';
import { JsonStore } from '../jsonStore.service.mjs';
import { GateActionExecutor } from './gateActionExecutor.mjs';
import { Ep2MiningActionExecutor } from './ep2MiningActionExecutor.mjs';
import { AiNodeMiningActionExecutor } from './aiNodeMiningActionExecutor.mjs';

export function createAutomationService(options) {
  const service = new AutomationService(options);
  service.start();
  return service;
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
  }) {
    this.enabled = enabled;
    this.dashboardFile = dashboardFile;
    this.devicesFile = devicesFile;
    this.snapshotFile = snapshotFile;
    this.collectorUrl = collectorUrl;
    this.pollMs = pollMs;
    this.normalizer = new StatusNormalizer();
    this.stateStore = new JsonStore(stateFile, { actions: {}, updatedAt: null });
    this.executors = {
      gate_pause: new GateActionExecutor(gateUrl),
      ep2_mining_reduce: new Ep2MiningActionExecutor(ep2BaseThreads),
      ainode_mining_reduce: new AiNodeMiningActionExecutor(),
    };
    this.status = {};
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
    if (!Object.keys(this.status).length) {
      const stored = await this.stateStore.read();
      this.status = stored.actions ?? {};
    }
    return this.status;
  }

  async tick() {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const [devices, settingsRaw] = await Promise.all([
        this.#loadDevices(),
        readFile(this.dashboardFile, 'utf8'),
      ]);
      const settings = JSON.parse(settingsRaw);
      const rules = Array.isArray(settings.rules) ? settings.rules : [];
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

  async #applyRule(rule, devices) {
    const source = devices.find((device) => device.id === rule.sourceDeviceId);
    const soc = Number(source?.soc);
    if (!Number.isFinite(soc)) return this.#record(rule, 'indeterminado', null, 'SOC de referencia indisponivel');

    const activateBelow = Number(rule.activateBelow);
    const resumeAbove = Number(rule.resumeAbove);
    const previous = this.status[rule.id]?.mode;
    let target;
    if (soc < activateBelow) target = 'active';
    else if (soc >= resumeAbove) target = 'inactive';
    else target = previous === 'active' ? 'active' : previous === 'inactive' ? 'inactive' : 'inactive';

    const executor = this.executors[rule.action];
    if (!executor) return this.#record(rule, target, soc, 'Atividade nao suportada');
    try {
      const action = await executor.apply(target, rule.desiredIntensity);
      this.#record(rule, target, soc, action, action.changed ? 'aplicada' : 'alinhada');
    } catch (error) {
      console.error(`[automation] ${rule.id}: ${error.message}`);
      this.#record(rule, target, soc, error.message, 'erro');
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
      return JSON.parse(await readFile(this.snapshotFile, 'utf8').catch(() => '{}'));
    }
  }

  #record(rule, mode, soc, detail, outcome = 'avaliada') {
    this.status[rule.id] = {
      ruleId: rule.id,
      action: rule.action,
      mode,
      soc,
      detail,
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
