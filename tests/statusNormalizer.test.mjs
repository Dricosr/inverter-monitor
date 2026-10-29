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
