import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

export class Ep2MiningActionExecutor {
  constructor(baseThreads = 30) {
    this.baseThreads = baseThreads;
    this.script = path.resolve(here, '..', '..', '..', 'deploy', 'set-ep2-mining.ps1');
  }

  async apply(target, desiredIntensity) {
    const threads = target === 'active'
      ? this.#reducedThreads(desiredIntensity)
      : this.baseThreads;
    const { stdout } = await execute(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', this.script, '-Threads', String(threads)],
      { windowsHide: true, timeout: 90_000 },
    );
    const changed = /changed=true/.test(stdout);
    const verified = /verified=true/.test(stdout);
    if (!verified) throw new Error(`XMRig nao confirmou ${threads} threads`);
    return {
      changed,
      applied: target === 'active',
      owned: target === 'active',
      detail: changed ? `${threads} threads aplicadas` : `${threads} threads ja estavam ativas`,
    };
  }

  #reducedThreads(desiredIntensity) {
    const percentage = Math.min(100, Math.max(1, Number(desiredIntensity) || 25));
    return Math.max(1, Math.min(this.baseThreads, Math.ceil(this.baseThreads * percentage / 100)));
  }
}
