import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutomationService } from '../src/services/automation/automationService.mjs';

class FakeExecutor {
  constructor() {
    this.calls = [];
    this.failNext = false;
  }

  async apply(target, intensity, context = {}) {
    this.calls.push({ target, intensity, previous: context.previous ?? null });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('falha simulada');
    }
    return {
      changed: true,
      applied: target === 'active',
      owned: target === 'active',
      detail: `${target} aplicado`,
    };
  }
}

async function buildService({ rules, devices, state, executors }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'automation-test-'));
  const stateFile = path.join(directory, 'state.json');
  if (state) await writeFile(stateFile, JSON.stringify(state), 'utf8');
  let currentDevices = devices;
  let currentRules = rules;
  const service = new AutomationService({
    enabled: true,
    stateFile,
    executors,
    rulesProvider: async () => currentRules,
    deviceProvider: async () => currentDevices,
  });
  return {
    service,
    setDevices: (value) => { currentDevices = value; },
    setRules: (value) => { currentRules = value; },
  };
}

function devicesWith(soc) {
  return [{ id: 'dev-a', soc }];
}

function gateRule(overrides = {}) {
  return {
    id: 'r-gate',
    enabled: true,
    action: 'gate_pause',
    sourceDeviceId: 'dev-a',
    activateBelow: 50,
    resumeAbove: 55,
    ...overrides,
  };
}

test('cada acao usa o inversor e o limiar da propria regra', async () => {
  const gate = new FakeExecutor();
  const ep2 = new FakeExecutor();
  const { service } = await buildService({
    rules: [
      gateRule(),
      gateRule({ id: 'r-ep2', action: 'ep2_mining_reduce', sourceDeviceId: 'dev-b', activateBelow: 70, resumeAbove: 75, desiredIntensity: 20 }),
    ],
    devices: [{ id: 'dev-a', soc: 40 }, { id: 'dev-b', soc: 80 }],
    executors: { gate_pause: gate, ep2_mining_reduce: ep2 },
  });

  await service.tick();

  assert.equal(gate.calls.length, 1);
  assert.equal(gate.calls[0].target, 'active');
  assert.equal(ep2.calls.length, 1);
  assert.equal(ep2.calls[0].target, 'inactive');
  assert.equal(ep2.calls[0].intensity, 20);
});

test('mantem a acao na histerese e libera acima do limite de retomada', async () => {
  const gate = new FakeExecutor();
  const { service, setDevices } = await buildService({
    rules: [gateRule()],
    devices: devicesWith(45),
    executors: { gate_pause: gate },
  });

  await service.tick();
  assert.equal(gate.calls.at(-1).target, 'active');

  setDevices(devicesWith(52));
  await service.tick();
  assert.equal(gate.calls.at(-1).target, 'active', 'SOC na histerese deve manter a pausa');

  setDevices(devicesWith(56));
  await service.tick();
  assert.equal(gate.calls.at(-1).target, 'inactive');

  await service.tick();
  assert.equal(gate.calls.at(-1).target, 'inactive', 'nao deve alternar sozinho');
});

test('SOC indisponivel nao libera a acao aplicada', async () => {
  const gate = new FakeExecutor();
  const { service, setDevices } = await buildService({
    rules: [gateRule()],
    devices: devicesWith(45),
    executors: { gate_pause: gate },
  });

  await service.tick();
  const callsAfterApply = gate.calls.length;

  setDevices([{ id: 'dev-a', soc: Number.NaN }]);
  await service.tick();

  assert.equal(gate.calls.length, callsAfterApply, 'executor nao deve ser chamado sem SOC');
  const status = await service.getStatus();
  assert.equal(status['r-gate'].mode, 'active');
  assert.equal(status['r-gate'].applied, true);
  assert.equal(status['r-gate'].outcome, 'indeterminada');
});

test('desabilitar a regra libera o recurso que ela aplicou', async () => {
  const gate = new FakeExecutor();
  const { service, setRules } = await buildService({
    rules: [gateRule()],
    devices: devicesWith(40),
    executors: { gate_pause: gate },
  });

  await service.tick();
  assert.equal(gate.calls.at(-1).target, 'active');

  setRules([gateRule({ enabled: false })]);
  await service.tick();

  assert.equal(gate.calls.at(-1).target, 'inactive');
  const status = await service.getStatus();
  assert.equal(status['r-gate'].mode, 'inactive');
  assert.equal(status['r-gate'].applied, false);
  assert.equal(status['r-gate'].outcome, 'liberada');
});

test('excluir a regra tambem libera o recurso aplicado', async () => {
  const gate = new FakeExecutor();
  const { service, setRules } = await buildService({
    rules: [gateRule()],
    devices: devicesWith(40),
    executors: { gate_pause: gate },
  });

  await service.tick();
  setRules([]);
  await service.tick();

  assert.equal(gate.calls.at(-1).target, 'inactive');
  const status = await service.getStatus();
  assert.equal(status['r-gate'].outcome, 'liberada');
});

test('falha em uma acao nao impede as outras', async () => {
  const gate = new FakeExecutor();
  const ep2 = new FakeExecutor();
  gate.failNext = true;
  const { service } = await buildService({
    rules: [gateRule(), gateRule({ id: 'r-ep2', action: 'ep2_mining_reduce', sourceDeviceId: 'dev-a' })],
    devices: devicesWith(40),
    executors: { gate_pause: gate, ep2_mining_reduce: ep2 },
  });

  await service.tick();

  const status = await service.getStatus();
  assert.equal(status['r-gate'].outcome, 'erro');
  assert.equal(status['r-ep2'].outcome, 'aplicada');
  assert.equal(ep2.calls.length, 1);
});

test('estado persistido alimenta a histerese antes do primeiro ciclo', async () => {
  const gate = new FakeExecutor();
  const { service } = await buildService({
    rules: [gateRule()],
    devices: devicesWith(52),
    executors: { gate_pause: gate },
    state: {
      actions: {
        'r-gate': { ruleId: 'r-gate', action: 'gate_pause', mode: 'active', applied: true, pausedAt: '2026-10-29T23:12:12.605Z' },
      },
    },
  });

  await service.tick();

  assert.equal(gate.calls.at(-1).target, 'active', 'restart nao pode retomar a fila sozinho');
  assert.equal(gate.calls.at(-1).previous.pausedAt, '2026-10-29T23:12:12.605Z');
});

test('pausa de outro operador nao e retomada pela automacao', async () => {
  const gate = new FakeExecutor();
  const { service } = await buildService({
    rules: [gateRule()],
    devices: devicesWith(56),
    executors: { gate_pause: gate },
    state: {
      actions: {
        'r-gate': { ruleId: 'r-gate', action: 'gate_pause', mode: 'inactive', applied: false, pausedAt: null },
      },
    },
  });

  await service.tick();

  assert.equal(gate.calls.length, 1);
  assert.equal(gate.calls[0].previous.pausedAt, null);
});
