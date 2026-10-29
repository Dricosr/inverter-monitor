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
      { windowsHide: true, timeout: 60_000 },
    );
    const changed = stdout.trim().endsWith('changed=true');
    return { changed, detail: changed ? `${threads} threads configuradas` : `${threads} threads ja configuradas` };
  }

  #reducedThreads(desiredIntensity) {
    const percentage = Math.min(100, Math.max(1, Number(desiredIntensity) || 25));
    return Math.max(1, Math.min(this.baseThreads, Math.ceil(this.baseThreads * percentage / 100)));
  }
}
