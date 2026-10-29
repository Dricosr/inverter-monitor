import { readFile } from 'node:fs/promises';

async function jsonRequest(url, timeoutMs = 2500, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function createIntegrationStatusService({ gateUrl, ep2XmrigUrl, ep2XmrigConfig, ep2XmrigToken }) {
  return {
    async getStatus() {
      const [gate, ep2Mining, aiNodeMining] = await Promise.all([
        gateStatus(gateUrl),
        ep2MiningStatus(ep2XmrigUrl, ep2XmrigConfig, ep2XmrigToken),
        aiNodeMiningStatus(gateUrl),
      ]);
      return { gate, ep2Mining, aiNodeMining };
    },
  };
}

async function gateStatus(baseUrl) {
  try {
    const value = await jsonRequest(`${baseUrl}/v1/status`);
    return { online: true, paused: value?.gate?.paused === true || value?.paused === true };
  } catch (error) {
    return { online: false, paused: null, error: error.message };
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
    return { online: false, error: error.message };
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

async function ep2MiningStatus(baseUrl, configPath, configuredToken) {
  let token = configuredToken;
  try {
    if (!token) {
      const rawConfig = await readFile(configPath, 'utf8');
      token = JSON.parse(rawConfig)?.http?.['access-token'] ?? '';
    }
  } catch (error) {
    return { online: false, error: `configuracao XMRig indisponivel: ${error.message}` };
  }
  try {
    const summary = await jsonRequest(
      `${baseUrl}/2/summary`,
      2500,
      token ? { Authorization: `Bearer ${token}` } : {},
    );
    return {
      online: true,
      hashrate: summary?.hashrate?.total?.[0] ?? summary?.hashrate?.total ?? null,
      threads: summary?.connection?.threads ?? summary?.resources?.threads ?? null,
    };
  } catch (error) {
    return { online: false, error: error.message };
  }
}
