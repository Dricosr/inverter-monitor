import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine } from '../src/domain/ruleEngine.mjs';

const devices = [{ id: 'main', name: 'Principal', soc: 49 }];

test('ativa uma regra abaixo do limite', () => {
  const result = new RuleEngine().evaluate({
    id: 'gate', enabled: true, action: 'gate_pause',
    sourceDeviceId: 'main', activateBelow: 50, resumeAbove: 55,
  }, devices, true);
  assert.equal(result.state, 'active');
  assert.equal(result.wouldExecute, true);
  assert.equal(result.executionEnabled, true);
});

test('mantem histerese entre os limites', () => {
  const result = new RuleEngine().evaluate({
    id: 'gate', enabled: true, action: 'gate_pause',
    sourceDeviceId: 'main', activateBelow: 45, resumeAbove: 55,
  }, [{ ...devices[0], soc: 50 }]);
  assert.equal(result.state, 'hysteresis');
  assert.equal(result.wouldExecute, false);
});

test('fica normal acima da faixa de retorno', () => {
  const result = new RuleEngine().evaluate({
    id: 'gate', enabled: true, action: 'gate_pause',
    sourceDeviceId: 'main', activateBelow: 50, resumeAbove: 55,
  }, [{ ...devices[0], soc: 56 }]);
  assert.equal(result.state, 'inactive');
});
