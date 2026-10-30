import { readFile } from 'node:fs/promises';
import { describeNetworkError } from '../domain/networkError.mjs';

async function jsonRequest(url, timeoutMs = 2500, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function createIntegrationStatusService({ gateUrl, ep2XmrigUrl, ep2XmrigConfig, ep2XmrigToken, ep2MaxThreads = null }) {
  return {
    async getStatus() {
      const [gate, ep2Mining, aiNodeMining] = await Promise.all([
        gateStatus(gateUrl),
        ep2MiningStatus(ep2XmrigUrl, ep2XmrigConfig, ep2XmrigToken, ep2MaxThreads),
        aiNodeMiningStatus(gateUrl),
      ]);
      return { gate, ep2Mining, aiNodeMining };
    },
  };
}

async function gateStatus(baseUrl) {
  try {
    const value = await jsonRequest(`${baseUrl}/v1/status`);
    const gate = value?.gate ?? {};
    return {
      online: true,
      paused: gate.paused === true || value?.paused === true,
      pausedBy: gate.pausedBy ?? null,
      pending: Number.isFinite(gate.pending) ? gate.pending : null,
    };
  } catch (error) {
    return { online: false, paused: null, error: describeNetworkError(error, 'Gate') };
  }
}

async function aiNodeMiningStatus(baseUrl) {
  try {
    const value = await jsonRequest(`${baseUrl}/v1/mining`);
    return {
      online: true,
      ...normalizeAiNodeHashrate(value),
      governor: value?.governor ?? null,
      threads: value?.threads ?? null,
      running: value?.running === true,
    };
  } catch (error) {
    return { online: false, error: describeNetworkError(error, 'ai-node') };
  }
}

export function normalizeAiNodeHashrate(value) {
  const nested = value?.hashrate && typeof value.hashrate === 'object' ? value.hashrate : {};
  const scalar = typeof value?.hashrate === 'number' ? value.hashrate : null;

  return {
    hashrate: nested.now10s ?? value?.hashrate10s ?? scalar,
    hashrate10s: nested.now10s ?? value?.hashrate10s ?? scalar,
    hashrate60s: nested.now60s ?? value?.hashrate60s ?? null,
    hashrate15m: nested.now15m ?? value?.hashrate15m ?? null,
  };
}

async function ep2MiningStatus(baseUrl, configPath, configuredToken, maxThreads = null) {
  let token = configuredToken;
  try {
    if (!token) {
      const rawConfig = await readFile(configPath, 'utf8');
      token = JSON.parse(rawConfig)?.http?.['access-token'] ?? '';
    }
  } catch (error) {
    return { online: false, error: `configuracao XMRig indisponivel: ${error.message}` };
  }

  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const [summary, backends] = await Promise.all([
      jsonRequest(`${baseUrl}/2/summary`, 2500, headers),
      jsonRequest(`${baseUrl}/2/backends`, 2500, headers).catch(() => null),
    ]);
    return {
      online: true,
      ...normalizeEp2Hashrate(summary?.hashrate?.total),
      threads: parseCpuThreads(backends),
      maxThreads,
    };
  } catch (error) {
    return { online: false, error: describeNetworkError(error, 'XMRig da EP2') };
  }
}

export function parseCpuThreads(backends) {
  const cpu = (Array.isArray(backends) ? backends : []).find((backend) => backend?.type === 'cpu');
  if (!cpu || !cpu.profile || !Array.isArray(cpu.threads)) return null;
  return cpu.threads.length;
}
export function normalizeEp2Hashrate(total) {
  const windows = Array.isArray(total) ? total.map(Number) : [];
  const usable = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

  return {
    hashrate: usable(windows[0]),
    hashrate10s: usable(windows[0]),
    hashrate60s: usable(windows[1]),
    hashrate15m: usable(windows[2]),
  };
}
