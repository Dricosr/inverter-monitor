import { readFile } from 'node:fs/promises';
import { StatusNormalizer } from '../domain/statusNormalizer.mjs';
import { JsonStore } from './jsonStore.service.mjs';
import { RuleEngine } from '../domain/ruleEngine.mjs';
import { createIntegrationStatusService } from './integrationStatus.service.mjs';

export class DashboardService {
  constructor({ devicesFile, snapshotFile, dashboardFile, gateUrl, ep2XmrigUrl, ep2XmrigConfig, ep2XmrigToken }) {
    this.devicesFile = devicesFile;
    this.snapshotFile = snapshotFile;
    this.normalizer = new StatusNormalizer();
    this.ruleEngine = new RuleEngine();
    this.store = new JsonStore(dashboardFile, this.#defaultDashboard());
    this.integrations = createIntegrationStatusService({ gateUrl, ep2XmrigUrl, ep2XmrigConfig, ep2XmrigToken });
  }

  async getDashboard() {
    const [devicesFile, snapshot, userSettings, integrations] = await Promise.all([
      readFile(this.devicesFile, 'utf8').catch(() => '[]'),
      readFile(this.snapshotFile, 'utf8').catch(() => '{}'),
      this.store.read(),
      this.integrations.getStatus(),
    ]);
    const devicesConfig = JSON.parse(devicesFile).map((device) => {
      const saved = userSettings.devices?.find((item) => item.id === device.name);
      return saved ? { ...device, displayName: saved.displayName } : device;
    });
    const snapshotJson = typeof snapshot === 'string' ? JSON.parse(snapshot || '{}') : snapshot;
    const devices = this.normalizer.normalize(snapshotJson, devicesConfig);
    const rules = Array.isArray(userSettings.rules) ? userSettings.rules : [];
    const intentions = this.ruleEngine.evaluateAll(rules, devices);

    return {
      snapshotTimestamp: snapshotJson.timestamp ?? null,
      snapshotAgeSeconds: this.#age(snapshotJson.timestamp),
      collector: {
        configuredSnapshot: this.snapshotFile,
        staleAfterSeconds: 120,
      },
      execution: { enabled: false, reason: 'Automacao fisica desativada nesta versao' },
      devices,
      rules,
      intentions,
      integrations,
    };
  }

  async updateDevice(id, displayName) {
    const settings = await this.store.read();
    const devices = settings.devices ?? [];
    const index = devices.findIndex((device) => device.id === id);
    if (index >= 0) {
      devices[index].displayName = displayName;
    } else {
      devices.push({ id, displayName });
    }
    settings.devices = devices;
    await this.store.write(settings);
  }

  async saveRule(rule) {
    const settings = await this.store.read();
    settings.rules ??= [];
    const index = settings.rules.findIndex((item) => item.id === rule.id);
    if (index >= 0) settings.rules[index] = rule;
    else settings.rules.push(rule);
    await this.store.write(settings);
  }

  async deleteRule(id) {
    const settings = await this.store.read();
    settings.rules = (settings.rules ?? []).filter((rule) => rule.id !== id);
    await this.store.write(settings);
  }

  #age(timestamp) {
    if (!timestamp) return null;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor((Date.now() - parsed) / 1000)) : null;
  }

  #defaultDashboard() {
    return { devices: [], rules: this.#defaultRules() };
  }

  #defaultRules() {
    return [
      {
        id: 'gate-low-battery',
        name: 'Pausar Gate com bateria baixa',
        enabled: false,
        action: 'gate_pause',
        sourceDeviceId: 'anenji-6k2',
        activateBelow: 50,
        resumeAbove: 55,
        desiredIntensity: null,
      },
      {
        id: 'ep2-mining-low-battery',
        name: 'Reduzir mineracao EP2',
        enabled: false,
        action: 'ep2_mining_reduce',
        sourceDeviceId: 'anenji-6k2',
        activateBelow: 50,
        resumeAbove: 55,
        desiredIntensity: 25,
      },
      {
        id: 'ainode-mining-low-battery',
        name: 'Reduzir mineracao ai-node',
        enabled: false,
        action: 'ainode_mining_reduce',
        sourceDeviceId: 'anenji-6k2',
        activateBelow: 50,
        resumeAbove: 55,
        desiredIntensity: 25,
      },
    ];
  }
}
