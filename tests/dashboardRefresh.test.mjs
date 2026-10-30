import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';

import { DashboardService } from '../src/services/dashboard.service.mjs';

async function montarServico() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inverter-ui-'));
  const devicesFile = path.join(dir, 'devices.json');
  const snapshotFile = path.join(dir, 'latest.json');
  const dashboardFile = path.join(dir, 'dashboard.json');
  await writeFile(devicesFile, JSON.stringify([
    { name: 'inversor-59', ip: '192.168.18.59', protocol: 'modbus_b', soc_on: 60, soc_off: 45 },
  ]));
  await writeFile(snapshotFile, '{}');
  const service = new DashboardService({
    devicesFile,
    snapshotFile,
    collectorUrl: 'http://127.0.0.1:8080/status',
    dashboardFile,
    gateUrl: 'http://127.0.0.1:1',
    ep2XmrigUrl: 'http://127.0.0.1:1',
    ep2XmrigConfig: path.join(dir, 'xmrig.json'),
    ep2XmrigToken: '',
  });
  return { service, dir, snapshotFile };
}

const snapshot = {
  timestamp: new Date().toISOString(),
  devices: {
    'inversor-59': {
      ip: '192.168.18.59',
      protocol: 'modbus_b',
      online: true,
      battery: { soc: 61, voltage: 52.6 },
      pv: { power: 900 },
      output: { active_power: 120 },
    },
  },
};

test('refresh pede um ciclo novo ao coletor antes de ler o painel', async () => {
  const { service } = await montarServico();
  const chamadas = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    chamadas.push({ url: String(url), method: options.method ?? 'GET' });
    if (String(url).endsWith('/refresh')) {
      return { ok: true, status: 200, json: async () => snapshot };
    }
    if (String(url).endsWith('/status')) {
      return { ok: true, status: 200, json: async () => snapshot };
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  try {
    const dashboard = await service.refresh();
    // /refresh precisa vir antes do /status, senao o painel mostra a leitura antiga
    assert.equal(chamadas[0].url, 'http://127.0.0.1:8080/refresh');
    assert.equal(chamadas[0].method, 'POST');
    assert.ok(chamadas.some((c) => c.url === 'http://127.0.0.1:8080/status'));
    assert.equal(dashboard.snapshotTimestamp, snapshot.timestamp);
    assert.equal(dashboard.devices[0].soc, 61);
  } finally {
    globalThis.fetch = original;
  }
});

test('refresh com o coletor fora do ar ainda devolve o painel', async () => {
  const { service, snapshotFile } = await montarServico();
  await writeFile(snapshotFile, JSON.stringify(snapshot));
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    const dashboard = await service.refresh();
    // cai para o snapshot em disco, sem derrubar a tela
    assert.equal(dashboard.collectorSource, 'snapshot_file');
    assert.equal(dashboard.devices[0].soc, 61);
  } finally {
    globalThis.fetch = original;
  }
});

test('refresh usa a URL configurada quando existir', async () => {
  const { service, dir } = await montarServico();
  const custom = new DashboardService({
    devicesFile: path.join(dir, 'devices.json'),
    snapshotFile: path.join(dir, 'latest.json'),
    collectorUrl: 'http://127.0.0.1:8080/status',
    collectorRefreshUrl: 'http://outro-host:9999/reload',
    dashboardFile: path.join(dir, 'dashboard.json'),
    gateUrl: 'http://127.0.0.1:1',
    ep2XmrigUrl: 'http://127.0.0.1:1',
    ep2XmrigConfig: path.join(dir, 'xmrig.json'),
    ep2XmrigToken: '',
  });
  const chamadas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    chamadas.push({ url: String(url), method: options.method ?? 'GET' });
    if (String(url).endsWith('/status')) {
      return { ok: true, status: 200, json: async () => snapshot };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    await custom.refresh();
    assert.ok(chamadas.some((c) => c.url === 'http://outro-host:9999/reload'));
    // a derivacao padrao nao deve ter sido usada
    assert.ok(!chamadas.some((c) => c.url === 'http://127.0.0.1:8080/refresh'));
  } finally {
    globalThis.fetch = original;
    void service;
  }
});

test('deriva a URL de refresh a partir da URL de status', async () => {
  const { dir } = await montarServico();
  const service = new DashboardService({
    devicesFile: path.join(dir, 'devices.json'),
    snapshotFile: path.join(dir, 'latest.json'),
    collectorUrl: 'http://10.0.0.5:8081/status/',
    dashboardFile: path.join(dir, 'dashboard.json'),
    gateUrl: 'http://127.0.0.1:1',
    ep2XmrigUrl: 'http://127.0.0.1:1',
    ep2XmrigConfig: path.join(dir, 'xmrig.json'),
    ep2XmrigToken: '',
  });
  assert.equal(service.refreshUrl, 'http://10.0.0.5:8081/refresh');
  await readFile(path.join(dir, 'devices.json'), 'utf8');
});
