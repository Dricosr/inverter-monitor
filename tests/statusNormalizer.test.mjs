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

