import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusNormalizer } from '../src/domain/statusNormalizer.mjs';

test('normaliza os formatos Python em um modelo de painel', () => {
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-29T12:00:00-03:00',
    devices: {
      a: {
        online: true,
        mode: 'Battery',
        battery: { soc: 41, voltage: 52.1, power: -100 },
        pv: { power: 800 },
        grid: {},
        output: { active_power: 900 },
        temperature: { inverter: 42 },
      },
    },
  }, [{ name: 'a', ip: '192.168.18.33' }]);

  assert.equal(result[0].id, 'a');
  assert.equal(result[0].soc, 41);
  assert.equal(result[0].pv.power, 800);
  assert.equal(result[0].output.activePower, 900);
});

test('campo ausente nao vira zero', () => {
  // Number(null) === 0: sem guarda, PV desconhecido aparecia como "0 W"
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T09:00:00-03:00',
    devices: {
      a: {
        online: true,
        battery: { soc: 47, voltage: 52.9 },
        pv: { voltage: 48, current: 0, power: null, dc_balance: 841 },
        grid: { voltage: null, frequency: null },
        output: { active_power: 312, current: null },
        temperature: {},
      },
    },
  }, [{ name: 'a' }]);

  assert.equal(result[0].pv.power, null, 'ausente deve continuar ausente');
  assert.equal(result[0].pv.dcBalance, 841);
  assert.equal(result[0].grid.voltage, null);
  assert.equal(result[0].output.current, null);
  assert.equal(result[0].temperature.inverter, null);
});

test('zero real continua zero', () => {
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T03:00:00-03:00',
    devices: { a: { online: true, battery: { soc: 40, voltage: 52 }, pv: { power: 0 }, output: {}, grid: {} } },
  }, [{ name: 'a' }]);
  assert.equal(result[0].pv.power, 0);
});

test('temperaturas, potencia por MPPT e corrente parcial', () => {
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T10:20:00-03:00',
    devices: {
      a: {
        online: true,
        battery: { soc: 61, voltage: 52.6, current_charge: 0, current_discharge: 0, current_partial: true },
        pv: { power: 231, mppt_power: [94, 137], voltage: 199, voltage2: 201.6 },
        grid: {},
        output: {},
        temperature: { inverter: 43, dcdc: 34, pv: 39 },
      },
      b: { online: true, battery: { soc: 45 }, pv: {}, output: {}, grid: {} },
    },
  }, [{ name: 'a' }, { name: 'b' }]);

  assert.deepEqual(result[0].pv.mpptPower, [94, 137]);
  assert.deepEqual(result[0].temperature, { inverter: 43, dcdc: 34, pv: 39 });
  assert.equal(result[0].battery.currentPartial, true);
  assert.equal(result[0].battery.chargeCurrent, 0, 'zero informado continua zero');
  assert.deepEqual(result[1].pv.mpptPower, [], 'sem dado nao inventa entrada');
  assert.equal(result[1].battery.currentPartial, false);
  assert.equal(result[1].temperature.pv, null);
});

test('normaliza uma entrada PV por MPPT e preserva a ilegivel', () => {
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T10:45:00-03:00',
    devices: {
      a: {
        online: true,
        battery: { soc: 62, voltage: 52.7 },
        pv: {
          power: 1255,
          inputs: [
            { mppt: 1, voltage: 213.8, current: 2.6, power: 570, readable: true },
            { mppt: 2, voltage: 198.5, current: 3.4, power: 685, readable: true },
          ],
        },
        output: {},
        grid: {},
      },
      b: {
        online: true,
        battery: { soc: 45, voltage: 53.1 },
        pv: {
          power: 0,
          inputs: [
            { mppt: 1, voltage: 45.5, current: 0, power: 0, readable: true },
            { mppt: 2, voltage: null, current: null, power: null, readable: false, reason: 'sem QPIGS2' },
          ],
        },
        output: {},
        grid: {},
      },
    },
  }, [{ name: 'a' }, { name: 'b' }], { snapshotAgeSeconds: 0 });

  assert.deepEqual(result[0].pv.inputs, [
    { mppt: 1, voltage: 213.8, current: 2.6, power: 570, readable: true, reason: null, currentSource: null, staleSeconds: null },
    { mppt: 2, voltage: 198.5, current: 3.4, power: 685, readable: true, reason: null, currentSource: null, staleSeconds: null },
  ]);
  // MPPT2 sem leitura nao pode herdar o valor do MPPT1
  assert.equal(result[1].pv.inputs[1].readable, false);
  assert.equal(result[1].pv.inputs[1].voltage, null);
  assert.equal(result[1].pv.inputs[1].power, null);
  assert.equal(result[1].pv.inputs[1].reason, 'sem QPIGS2');
  assert.equal(result[1].pv.inputs[0].power, 0, 'zero medido continua zero');
});

test('PN entra sempre; SN so quando o aparelho informa de verdade', () => {
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T11:00:00-03:00',
    devices: {
      a: { online: true, pn: 'I30000251546403679', serial: '92B32504103913', battery: {}, pv: {}, output: {}, grid: {} },
      b: { online: true, pn: 'Q0045529822108', serial: '55355535553555', serial_trusted: false, battery: {}, pv: {}, output: {}, grid: {} },
      c: { online: true, battery: {}, pv: {}, output: {}, grid: {} },
    },
  }, [{ name: 'a' }, { name: 'b' }, { name: 'c', pn: 'Q0048085649157' }]);

  assert.equal(result[0].pn, 'I30000251546403679');
  assert.equal(result[0].serial, '92B32504103913');
  assert.equal(result[0].serialTrusted, true);
  // O QID do .106 devolve um placeholder: o serial nao pode ser exibido como verdadeiro
  assert.equal(result[1].serial, '55355535553555');
  assert.equal(result[1].serialTrusted, false);
  assert.equal(result[2].pn, 'Q0048085649157', 'devices.json serve de fonte do PN');
  assert.equal(result[2].serial, null);
  assert.equal(result[2].serialTrusted, false);
});

test('corrente derivada chega marcada como tal', () => {
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T11:40:00-03:00',
    devices: {
      a: {
        online: true,
        battery: { soc: 51, voltage: 53.3 },
        pv: {
          power: 1127,
          inputs: [
            { mppt: 1, voltage: 45.2, current: 0, power: 0, readable: true },
            { mppt: 2, voltage: 302.2, current: 3.7, power: 1127, readable: true,
              current_source: 'derivada (W ÷ V) — o firmware nao expoe a corrente' },
          ],
        },
        output: {},
        grid: {},
      },
    },
  }, [{ name: 'a' }]);

  assert.equal(result[0].pv.inputs[1].current, 3.7);
  assert.match(result[0].pv.inputs[1].currentSource, /derivada/);
  assert.equal(result[0].pv.inputs[0].currentSource, null, 'leitura direta nao e marcada');
});

test('offline preserva motivo e hora da ultima leitura', () => {
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T09:00:00-03:00',
    devices: {
      a: {
        online: false,
        error: 'TimeoutError: nao conectou de volta',
        last_ok: '2026-10-30T08:55:00-03:00',
      },
    },
  }, [{ name: 'a' }], { snapshotAgeSeconds: 0 });

  assert.equal(result[0].online, false);
  assert.match(result[0].error, /nao conectou/);
  assert.equal(result[0].lastOk, '2026-10-30T08:55:00-03:00');
  assert.equal(result[0].soc, null);
  assert.equal(result[0].stale.whole, false, 'sem cache nao ha o que mostrar como velho');
  assert.deepEqual(result[0].stale.fields, {});
});

test('snapshot velho invalida todos os valores, nao so o que faltou', async () => {
  // Caso real (30/10, 18:55): o coletor morreu as 18:49 e a UI mostrou
  // "Leitura atrasada" no topo, mas os cards com numeros de cara fresca.
  const { StatusNormalizer } = await import('../src/domain/statusNormalizer.mjs');
  const result = new StatusNormalizer().normalize({
    timestamp: new Date(Date.now() - 381_000).toISOString(),
    devices: {
      a: {
        online: true,
        last_ok: new Date(Date.now() - 381_000).toISOString(),
        battery: { soc: 62, voltage: 52.7 },
        pv: { power: 1200, inputs: [{ mppt: 1, voltage: 300, current: 4, power: 1200, readable: true }] },
        output: { active_power: 500 },
        grid: {},
        temperature: { inverter: 45 },
      },
    },
  }, [{ name: 'a' }], { snapshotAgeSeconds: 381, staleAfterSeconds: 120 });

  const device = result[0];
  assert.equal(device.snapshotStale, true);
  assert.equal(device.stale.whole, true, 'o arquivo inteiro esta velho');
  assert.ok(device.stale.ageSeconds >= 381, `idade do snapshot (${device.stale.ageSeconds})`);
  assert.ok(device.pv.inputs[0].staleSeconds >= 381, 'MPPT tambem envelhece');
  assert.equal(device.soc, 62, 'o ultimo valor conhecido continua visivel');
});

test('snapshot recente nao marca nada como velho', async () => {
  const { StatusNormalizer } = await import('../src/domain/statusNormalizer.mjs');
  const result = new StatusNormalizer().normalize({
    timestamp: new Date().toISOString(),
    devices: { a: { online: true, battery: { soc: 50, voltage: 52 }, pv: {}, output: {}, grid: {} } },
  }, [{ name: 'a' }], { snapshotAgeSeconds: 3, staleAfterSeconds: 120 });

  assert.equal(result[0].snapshotStale, false);
  assert.equal(result[0].stale.whole, false);
  assert.equal(result[0].stale.ageSeconds, null);
});

const iso = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();

test('valor do cache fica marcado com a idade, nao vira "nao exposto"', () => {
  // .106 com o 0925 mudo: o coletor devolve o MPPT2 da ultima leitura boa e diz
  // que ele veio de 40 s atras. Antes a UI mostrava "nao exposto", que era mentira.
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T13:00:00-03:00',
    devices: {
      a: {
        online: true,
        last_ok: '2026-10-30T13:00:00-03:00',
        battery: { soc: 61, voltage: 53.9 },
        pv: {
          power: 0,
          mppt_unreadable: [],
          inputs: [
            { mppt: 1, voltage: 45.1, current: 0, power: 0, readable: true },
            { mppt: 2, voltage: 302.2, current: 3.7, power: 1118, readable: true },
          ],
        },
        output: { active_power: 331 },
        grid: {},
        cache: {
          at: iso(40),
          fields: {
            'pv.inputs.1.voltage': iso(40),
            'pv.inputs.1.current': iso(40),
            'pv.inputs.1.power': iso(40),
          },
        },
      },
    },
  }, [{ name: 'a' }], { snapshotAgeSeconds: 0 });

  const mppt2 = result[0].pv.inputs[1];
  assert.equal(mppt2.readable, true, 'continua legivel: existe valor na tela');
  assert.equal(mppt2.power, 1118, 'o ultimo valor valido nao e apagado');
  assert.ok(mppt2.staleSeconds >= 40, `idade medida (${mppt2.staleSeconds})`);
  assert.equal(result[0].pv.inputs[0].staleSeconds, null, 'MPPT1 veio agora');
  // O total do ciclo (0 W) somava so a entrada fresca e contradizia o visor.
  assert.equal(result[0].pv.power, 1118, 'total acompanha o que esta na tela');
  assert.ok(result[0].stale.fields['pv.power'] >= 40);
});

test('card inteiro do cache e marcado como todo desatualizado', () => {
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T13:00:00-03:00',
    devices: {
      a: {
        online: false,
        error: 'TimeoutError: sem conexao',
        last_ok: iso(95),
        battery: { soc: 44, voltage: 51.8, current_charge: 0, current_discharge: 6 },
        pv: { power: 700, inputs: [{ mppt: 1, voltage: 200, current: 3.5, power: 700, readable: true }] },
        output: { active_power: 400 },
        grid: {},
        temperature: { inverter: 41 },
        cache: {
          at: iso(95),
          fields: {
            'battery.soc': iso(95),
            'battery.voltage': iso(95),
            'output.active_power': iso(95),
            'temperature.inverter': iso(95),
            'pv.power': iso(95),
            'pv.inputs.0.power': iso(95),
          },
        },
      },
    },
  }, [{ name: 'a' }], { snapshotAgeSeconds: 0 });

  assert.equal(result[0].online, false);
  assert.equal(result[0].stale.whole, true);
  assert.ok(result[0].stale.ageSeconds >= 95);
  assert.ok(result[0].lastOkAgeSeconds >= 95, 'a UI mostra ha quanto tempo nao ha resposta');
  assert.equal(result[0].soc, 44, 'o ultimo SOC valido continua visivel');
  assert.equal(result[0].temperature.inverter, 41);
});

test('leitura parcial marca so o campo que veio do cache', () => {
  const result = new StatusNormalizer().normalize({
    timestamp: '2026-10-30T13:00:00-03:00',
    devices: {
      a: {
        online: true,
        last_ok: '2026-10-30T13:00:00-03:00',
        battery: { soc: 58, voltage: 53.4 },
        pv: { power: 1200, inputs: [] },
        output: { active_power: 500 },
        grid: {},
        temperature: { inverter: 47 },
        cache: { at: iso(30), fields: { 'temperature.inverter': iso(30) } },
      },
    },
  }, [{ name: 'a' }], { snapshotAgeSeconds: 0 });

  const stale = result[0].stale;
  assert.equal(stale.whole, false, 'inversor respondeu: o card nao esta todo velho');
  assert.equal(result[0].stale.fields['output.active_power'], undefined, 'saida veio agora');
  assert.ok(stale.fields['temperature.inverter'] >= 30);
});

test('regra nao decide com SOC vindo do cache', async () => {
  const { RuleEngine } = await import('../src/domain/ruleEngine.mjs');
  const devices = [{
    id: 'a', name: 'a', online: false, soc: 20,
    stale: { whole: true, fields: { 'battery.soc': 120 } },
  }];
  const rule = { id: 'r', enabled: true, action: 'gate_pause', sourceDeviceId: 'a', activateBelow: 50, resumeAbove: 60 };
  const result = new RuleEngine().evaluate(rule, devices, true);
  assert.equal(result.state, 'indeterminate');
  assert.equal(result.wouldExecute, false, 'SOC velho nunca dispara acao');
  assert.equal(result.sourceStale, true);
});

