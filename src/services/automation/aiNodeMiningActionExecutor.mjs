import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export class AiNodeMiningActionExecutor {
  async apply(target, desiredIntensity) {
    const { stdout } = await execute(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'ai-node', '/usr/local/sbin/ainode-mining-mode status'],
      { windowsHide: true, timeout: 30_000 },
    );
    const command = target === 'active'
      ? `sudo -n /usr/local/sbin/ainode-mining-mode ai ${this.#quota(desiredIntensity)}`
      : 'sudo -n /usr/local/sbin/ainode-mining-mode normal';
    const currentMode = stdout.includes('mode=ai') ? 'active' : 'inactive';
    const requestedMode = target === 'active' ? 'active' : 'inactive';
    if (currentMode === requestedMode && (target !== 'active' || this.#quotaFromStatus(stdout) === this.#quota(desiredIntensity))) {
      return {
        changed: false,
        applied: target === 'active',
        owned: target === 'active',
        detail: target === 'active' ? `CPUQuota ja limitada a ${this.#quota(desiredIntensity)}%` : 'mineracao ja liberada',
      };
    }
    await execute(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'ai-node', command],
      { windowsHide: true, timeout: 30_000 },
    );
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
