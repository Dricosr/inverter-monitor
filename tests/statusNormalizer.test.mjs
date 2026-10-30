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
  }, [{ name: 'a' }, { name: 'b' }]);

  assert.deepEqual(result[0].pv.inputs, [
    { mppt: 1, voltage: 213.8, current: 2.6, power: 570, readable: true, reason: null },
    { mppt: 2, voltage: 198.5, current: 3.4, power: 685, readable: true, reason: null },
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
  }, [{ name: 'a' }]);

  assert.equal(result[0].online, false);
  assert.match(result[0].error, /nao conectou/);
  assert.equal(result[0].lastOk, '2026-10-30T08:55:00-03:00');
  assert.equal(result[0].soc, null);
});

