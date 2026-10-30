import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceConfirmation } from '../src/domain/confirmationGate.mjs';

const at = (seconds) => Date.UTC(2026, 9, 30, 12, 0, seconds);

test('confirmSeconds 0 age imediatamente (comportamento antigo)', () => {
  const result = advanceConfirmation({ target: 'active', pending: null, now: at(0), confirmSeconds: 0 });
  assert.equal(result.action, 'act');
});

test('primeira leitura do gatilho so abre a contagem', () => {
  const result = advanceConfirmation({ target: 'active', pending: null, now: at(0), confirmSeconds: 120 });
  assert.equal(result.action, 'wait');
  assert.equal(result.pending.target, 'active');
  assert.equal(result.pending.since, new Date(at(0)).toISOString());
  assert.equal(result.remainingSeconds, 120);
});

test('mantendo o gatilho, age quando o tempo fecha', () => {
  const first = advanceConfirmation({ target: 'active', pending: null, now: at(0), confirmSeconds: 120 });
  const midway = advanceConfirmation({ target: 'active', pending: first.pending, now: at(60), confirmSeconds: 120 });
  assert.equal(midway.action, 'wait');
  assert.equal(midway.waitedSeconds, 60);
  assert.equal(midway.remainingSeconds, 60);

  const done = advanceConfirmation({ target: 'active', pending: midway.pending, now: at(121), confirmSeconds: 120 });
  assert.equal(done.action, 'act');
  assert.equal(done.pending, null, 'confirmado limpa o estado');
});

test('leitura nao confiavel cancela a contagem em vez de pausar', () => {
  const first = advanceConfirmation({ target: 'active', pending: null, now: at(0), confirmSeconds: 120 });
  const lost = advanceConfirmation({ target: null, pending: first.pending, now: at(100), confirmSeconds: 120 });
  assert.equal(lost.action, 'cancel');
  assert.equal(lost.pending, null);

  // Depois da falha o gatilho recomeca do zero, mesmo com o SOC ainda baixo: o
  // tempo anterior nao vale, senao uma leitura ruim no meio "adiantaria" a acao.
  const again = advanceConfirmation({ target: 'active', pending: lost.pending, now: at(110), confirmSeconds: 120 });
  assert.equal(again.action, 'wait');
  assert.equal(again.waitedSeconds, 0);
});

test('inverter o alvo recomeca a contagem', () => {
  const first = advanceConfirmation({ target: 'active', pending: null, now: at(0), confirmSeconds: 120 });
  const flipped = advanceConfirmation({ target: 'inactive', pending: first.pending, now: at(90), confirmSeconds: 120 });
  assert.equal(flipped.action, 'wait');
  assert.equal(flipped.waitedSeconds, 0, 'o relogio do alvo anterior nao vale');
  assert.equal(flipped.pending.target, 'inactive');
});

test('pending corrompido no disco nao trava a regra', () => {
  const result = advanceConfirmation({
    target: 'active', pending: { target: 'active', since: 'ontem' }, now: at(0), confirmSeconds: 120,
  });
  assert.equal(result.action, 'wait');
  assert.equal(result.waitedSeconds, 0);
  assert.equal(result.pending.since, new Date(at(0)).toISOString());
});
