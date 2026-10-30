import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

export function parseCpuThreads(payload) {
  const backends = Array.isArray(payload) ? payload : [];
  const cpu = backends.find((backend) => backend?.type === 'cpu');
  // Durante a inicializacao o XMRig publica o array de threads incompleto e sem
  // perfil; nesse estado a contagem nao serve para decidir nada.
  if (!cpu || !cpu.profile || !Array.isArray(cpu.threads)) return null;
  return cpu.threads.length;
}

export class Ep2MiningActionExecutor {
  constructor(baseThreads = 30, options = {}) {
    this.baseThreads = baseThreads;
    this.apiUrl = (options.apiUrl ?? 'http://127.0.0.1:18092').replace(/\/$/, '');
    this.configPath = options.configPath ?? String.raw`D:\Monero\xmrig\config.json`;
    this.token = options.token ?? '';
    this.script = path.resolve(here, '..', '..', '..', 'deploy', 'set-ep2-mining.ps1');
  }

  async apply(target, desiredIntensity) {
    const threads = target === 'active' ? this.#reducedThreads(desiredIntensity) : this.baseThreads;
    const active = target === 'active';

    const probe = await this.#probe();
    if (probe.reachable && probe.threads === null && probe.uptime < 20) {
      return { changed: false, applied: active, owned: active, detail: 'XMRig iniciando' };
    }
    if (probe.threads === threads) {
      return { changed: false, applied: active, owned: active, detail: `${threads} threads confirmadas` };
    }

    await execute(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', this.script, '-Threads', String(threads)],
      { windowsHide: true, timeout: 90_000 },
    );

    const current = await this.#waitForThreads(threads, 20_000);
    if (current !== threads) {
      throw new Error(`XMRig nao confirmou ${threads} threads (atual: ${current ?? 'sem resposta'})`);
    }
    return { changed: true, applied: active, owned: active, detail: `${threads} threads aplicadas` };
  }

  async #probe() {
    try {
      const token = await this.#token();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const [summary, backends] = await Promise.all([
        this.#json('/2/summary', headers),
        this.#json('/2/backends', headers),
      ]);
      return {
        reachable: true,
        uptime: Number(summary?.uptime ?? 0),
        threads: parseCpuThreads(backends),
      };
    } catch {
      return { reachable: false, uptime: 0, threads: null };
    }
  }

  async #json(path, headers) {
    const response = await fetch(`${this.apiUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async #token() {
    if (this.token) return this.token;
    try {
      const config = JSON.parse(await readFile(this.configPath, 'utf8'));
      return config?.http?.['access-token'] ?? '';
    } catch {
      return '';
    }
  }

  async #waitForThreads(threads, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let current = (await this.#probe()).threads;
    while (current !== threads && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = (await this.#probe()).threads;
    }
    return current;
  }

  #reducedThreads(desiredIntensity) {
    const percentage = Math.min(100, Math.max(1, Number(desiredIntensity) || 25));
    return Math.max(1, Math.min(this.baseThreads, Math.ceil(this.baseThreads * percentage / 100)));
  }
}
