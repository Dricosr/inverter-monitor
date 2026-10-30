import { createSshRunner } from './aiNodeSsh.mjs';

export class AiNodeMiningActionExecutor {
  constructor(host = 'ai-node', { ssh = createSshRunner(host) } = {}) {
    this.host = host;
    this.ssh = ssh;
  }

  async apply(target, desiredIntensity) {
    const status = await this.ssh('/usr/local/sbin/ainode-mining-mode status');
    const command = target === 'active'
      ? `sudo -n /usr/local/sbin/ainode-mining-mode ai ${this.#quota(desiredIntensity)}`
      : 'sudo -n /usr/local/sbin/ainode-mining-mode normal';
    const currentMode = status.includes('mode=ai') ? 'active' : 'inactive';
    const requestedMode = target === 'active' ? 'active' : 'inactive';
    if (currentMode === requestedMode && (target !== 'active' || this.#quotaFromStatus(status) === this.#quota(desiredIntensity))) {
      return {
        changed: false,
        applied: target === 'active',
        owned: target === 'active',
        detail: target === 'active' ? `CPUQuota ja limitada a ${this.#quota(desiredIntensity)}%` : 'mineracao ja liberada',
      };
    }
    await this.ssh(command);
    return {
      changed: true,
      applied: target === 'active',
      owned: target === 'active',
      detail: target === 'active' ? `CPUQuota limitada a ${this.#quota(desiredIntensity)}%` : 'mineracao liberada',
    };
  }

  #quota(desiredIntensity) {
    return Math.min(100, Math.max(1, Number(desiredIntensity) || 25));
  }

  #quotaFromStatus(status) {
    const milliseconds = status.match(/quota=(\d+)ms/)?.[1];
    if (milliseconds) return Math.round(Number(milliseconds) / 10);
    const seconds = status.match(/quota=(\d+(?:\.\d+)?)s/)?.[1];
    if (seconds) return Math.round(Number(seconds) * 100);
    return null;
  }
}
