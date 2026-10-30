import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'ai-node'];

export class AiNodeMiningActionExecutor {
  constructor(host = 'ai-node') {
    this.host = host;
  }

  async apply(target, desiredIntensity) {
    const status = await this.#run('/usr/local/sbin/ainode-mining-mode status');
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
    await this.#run(command);
    return {
      changed: true,
      applied: target === 'active',
      owned: target === 'active',
      detail: target === 'active' ? `CPUQuota limitada a ${this.#quota(desiredIntensity)}%` : 'mineracao liberada',
    };
  }

  async #run(command) {
    try {
      const { stdout } = await execute('ssh', [...SSH_OPTIONS, command], {
        windowsHide: true,
        timeout: 30_000,
      });
      return stdout;
    } catch (error) {
      // O execFile devolve "Command failed: ssh -o ..." com o comando inteiro; na
      // tela isso nao ajuda em nada.
      const stderr = String(error.stderr ?? '');
      const message = String(error.message ?? error);
      const both = `${stderr} ${message}`;
      if (/timed out|timeout/i.test(both) || /ETIMEDOUT/.test(message)) {
        throw new Error(`${this.host} nao respondeu a tempo (timeout)`);
      }
      if (/Permission denied|publickey/i.test(both)) {
        throw new Error(`${this.host} recusou a chave SSH`);
      }
      if (/Could not resolve|Name or service not known/i.test(both)) {
        throw new Error(`${this.host} nao encontrado na rede`);
      }
      const detail = (stderr.trim() || message).split('\n')[0];
      throw new Error(`${this.host}: ${detail}`);
    }
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
