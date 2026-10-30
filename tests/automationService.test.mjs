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
    this.state = null;
  }

  async apply(target, intensity, context = {}) {
    this.calls.push({ target, intensity, previous: context.previous ?? null });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('falha simulada');
    }
    // Como os executores reais: `changed` so quando o alvo muda de estado.
    const changed = this.state !== target;
    this.state = target;
    return {
      changed,
      applied: target === 'active',
      owned: target === 'active',
      detail: `${target} ${changed ? 'aplicado' : 'ja estava'}`,
    };
  }
}

async function buildService({ rules, devices, state, executors, now, errorBackoffSeconds }) {
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
    now: now ?? (() => Date.now()),
    errorBackoffSeconds,
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
  assert.equal(status['r-gate'].applied, true, 'nada e liberado no escuro');
  assert.equal(status['r-gate'].outcome, 'sem_leitura');
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

// --- Leitura confiavel: a automacao nao decide com dado velho -------------------

function deviceWith(soc, extra = {}) {
  return [{ id: 'dev-a', soc, online: true, ...extra }];
}

test('SOC vindo do cache nao dispara nem libera nada', async () => {
  const power = new FakeExecutor();
  const { service } = await buildService({
    rules: [gateRule({ id: 'r-power', action: 'ainode_power_off', activateBelow: 40, resumeAbove: 50 })],
    devices: deviceWith(20, { stale: { whole: false, fields: { 'battery.soc': 95 } } }),
    executors: { ainode_power_off: power },
  });

  await service.tick();

  assert.equal(power.calls.length, 0, 'desligar maquina com SOC de 95 s atras seria irreversivel');
  const status = await service.getStatus();
  assert.equal(status['r-power'].outcome, 'sem_leitura');
  assert.match(status['r-power'].detail.detail, /cache/);
});

test('snapshot velho bloqueia a acao mesmo com o inversor online', async () => {
  const power = new FakeExecutor();
  const { service } = await buildService({
    rules: [gateRule({ id: 'r-power', action: 'ainode_power_off' })],
    devices: deviceWith(20, { snapshotStale: true, stale: { whole: true, ageSeconds: 400, fields: {} } }),
    executors: { ainode_power_off: power },
  });

  await service.tick();

  assert.equal(power.calls.length, 0);
  const status = await service.getStatus();
  assert.match(status['r-power'].detail.detail, /snapshot com 400s/);
});

test('inversor offline nao dispara a acao', async () => {
  const power = new FakeExecutor();
  const { service } = await buildService({
    rules: [gateRule({ id: 'r-power', action: 'ainode_power_off' })],
    devices: deviceWith(20, { online: false }),
    executors: { ainode_power_off: power },
  });

  await service.tick();
  assert.equal(power.calls.length, 0);
  assert.match((await service.getStatus())['r-power'].detail.detail, /sem resposta/);
});

// --- Confirmacao: o gatilho precisa se manter ------------------------------------

test('nao age na primeira leitura do gatilho: abre a janela de confirmacao', async () => {
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const power = new FakeExecutor();
  const { service } = await buildService({
    rules: [gateRule({ id: 'r-power', action: 'ainode_power_off', activateBelow: 40, resumeAbove: 50, confirmSeconds: 120 })],
    devices: deviceWith(35),
    executors: { ainode_power_off: power },
    now: () => clock,
  });

  await service.tick();
  assert.equal(power.calls.length, 0, 'primeira leitura so abre a contagem');
  let status = await service.getStatus();
  assert.equal(status['r-power'].outcome, 'confirmando');
  assert.equal(status['r-power'].pending.target, 'active');

  clock += 60_000;
  await service.tick();
  assert.equal(power.calls.length, 0, 'ainda dentro da janela');
  status = await service.getStatus();
  assert.equal(status['r-power'].outcome, 'confirmando');
  assert.match(status['r-power'].detail.detail, /confirma em 60s/);

  clock += 61_000;
  await service.tick();
  assert.equal(power.calls.length, 1, 'passou da janela: age');
  assert.equal(power.calls[0].target, 'active');
  status = await service.getStatus();
  assert.equal(status['r-power'].outcome, 'aplicada');
  assert.equal(status['r-power'].pending, null, 'confirmado limpa a janela');
});

test('SOC voltando antes do fim da janela cancela a acao', async () => {
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const power = new FakeExecutor();
  const { service, setDevices } = await buildService({
    rules: [gateRule({ id: 'r-power', action: 'ainode_power_off', activateBelow: 40, resumeAbove: 50, confirmSeconds: 120 })],
    devices: deviceWith(35),
    executors: { ainode_power_off: power },
    now: () => clock,
  });

  await service.tick();
  assert.equal(power.calls.length, 0, 'janela aberta, nada aplicado');

  clock += 90_000;
  setDevices(deviceWith(52));
  await service.tick();

  // A nuvem passou: nada e desligado, e o alvo inverte — a janela recomeca do zero.
  assert.equal(power.calls.length, 0, 'nao desliga depois que o SOC voltou');
  const status = await service.getStatus();
  assert.equal(status['r-power'].outcome, 'confirmando');
  assert.equal(status['r-power'].pending.target, 'inactive');

  clock += 121_000;
  await service.tick();
  assert.equal(power.calls.at(-1).target, 'inactive', 'so alinha depois da janela');
});

test('acao ja aplicada nao reabre a janela a cada ciclo', async () => {
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const power = new FakeExecutor();
  const { service } = await buildService({
    rules: [gateRule({ id: 'r-power', action: 'ainode_power_off', activateBelow: 40, resumeAbove: 50, confirmSeconds: 120 })],
    devices: deviceWith(35),
    executors: { ainode_power_off: power },
    now: () => clock,
  });

  await service.tick();
  clock += 121_000;
  await service.tick();
  assert.equal(power.calls.at(-1).target, 'active');
  assert.equal((await service.getStatus())['r-power'].outcome, 'aplicada');

  // SOC continua baixo: o estado ja esta aplicado, entao so realinha (barato).
  clock += 20_000;
  await service.tick();
  let status = await service.getStatus();
  assert.equal(status['r-power'].outcome, 'alinhada');
  assert.equal(status['r-power'].pending, null, 'nao ha nova janela de confirmacao');

  clock += 20_000;
  await service.tick();
  status = await service.getStatus();
  assert.equal(status['r-power'].outcome, 'alinhada');
});

test('religar depois de desligado espera a confirmacao antes de mandar o WOL', async () => {
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const power = new FakeExecutor();
  const { service, setDevices } = await buildService({
    rules: [gateRule({ id: 'r-power', action: 'ainode_power_off', activateBelow: 40, resumeAbove: 50, confirmSeconds: 120 })],
    devices: deviceWith(35),
    executors: { ainode_power_off: power },
    now: () => clock,
  });

  await service.tick();
  clock += 121_000;
  await service.tick();
  assert.equal(power.calls.at(-1).target, 'active', 'desligou depois da janela');

  // SOC recupera: agora ha algo desligado por nos, entao a volta tambem confirma.
  setDevices(deviceWith(60));
  clock += 10_000;
  await service.tick();
  assert.equal(power.calls.at(-1).target, 'active', 'nao liga na primeira leitura alta');
  assert.equal((await service.getStatus())['r-power'].outcome, 'confirmando');

  clock += 121_000;
  await service.tick();
  assert.equal(power.calls.at(-1).target, 'inactive', 'ligou depois da janela');
});

test('leitura ruim no meio da janela zera a contagem', async () => {
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const power = new FakeExecutor();
  const { service, setDevices } = await buildService({
    rules: [gateRule({ id: 'r-power', action: 'ainode_power_off', activateBelow: 40, resumeAbove: 50, confirmSeconds: 120 })],
    devices: deviceWith(35),
    executors: { ainode_power_off: power },
    now: () => clock,
  });

  await service.tick();
  clock += 100_000;
  setDevices(deviceWith(35, { stale: { whole: false, fields: { 'battery.soc': 30 } } }));
  await service.tick();
  assert.equal((await service.getStatus())['r-power'].outcome, 'sem_leitura');

  // SOC volta fresco e baixo: a contagem recomeca, nao completa o que faltava.
  clock += 30_000;
  setDevices(deviceWith(35));
  await service.tick();
  assert.equal(power.calls.length, 0, 'a espera anterior nao vale depois de uma falha');
  assert.equal((await service.getStatus())['r-power'].outcome, 'confirmando');
});

test('acao que falha respeita backoff antes de tentar de novo', async () => {
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const power = new FakeExecutor();
  power.failNext = true;
  const { service } = await buildService({
    rules: [gateRule({ id: 'r-power', action: 'ainode_power_off' })],
    devices: deviceWith(20),
    executors: { ainode_power_off: power },
    now: () => clock,
    errorBackoffSeconds: 120,
  });

  await service.tick();
  assert.equal(power.calls.length, 1);
  assert.equal((await service.getStatus())['r-power'].outcome, 'erro');

  clock += 30_000;
  await service.tick();
  assert.equal(power.calls.length, 1, 'nao martela o alvo a cada ciclo');
  assert.match((await service.getStatus())['r-power'].detail.detail, /nova tentativa em 90s/);

  clock += 95_000;
  await service.tick();
  assert.equal(power.calls.length, 2, 'depois do backoff tenta de novo');
});

test('confirmSeconds ausente mantem o comportamento imediato', async () => {
  const gate = new FakeExecutor();
  const { service } = await buildService({
    rules: [gateRule()],
    devices: deviceWith(40),
    executors: { gate_pause: gate },
  });
  await service.tick();
  assert.equal(gate.calls.length, 1);
});

