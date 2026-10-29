import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, '..');

export function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  port: numberFromEnv('PORT', 3071),
  host: process.env.HOST || '0.0.0.0',
  devicesFile: process.env.INVERTER_DEVICES_FILE || path.join(rootDir, 'devices.json'),
  snapshotFile: process.env.INVERTER_SNAPSHOT_FILE || path.join(rootDir, 'data', 'latest.json'),
  dashboardFile: process.env.INVERTER_DASHBOARD_FILE || path.join(rootDir, 'data', 'dashboard.json'),
  pollMs: numberFromEnv('DASHBOARD_POLL_MS', 10_000),
  gateUrl: process.env.GATE_BASE_URL || 'http://192.168.18.150:3070',
  ep2XmrigUrl: process.env.EP2_XMRIG_URL || 'http://127.0.0.1:18092',
  ep2XmrigConfig: process.env.EP2_XMRIG_CONFIG || String.raw`D:\Monero\xmrig\config.json`,
  ep2XmrigToken: process.env.EP2_XMRIG_TOKEN || '',
};
