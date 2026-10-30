import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCpuThreads } from '../src/services/automation/ep2MiningActionExecutor.mjs';

test('conta as threads reais do backend de CPU', () => {
  const payload = [
    { type: 'opencl', threads: [1, 2] },
    { type: 'cpu', profile: 'rx', threads: [{ affinity: 0 }, { affinity: 2 }, { affinity: 4 }] },
  ];
  assert.equal(parseCpuThreads(payload), 3);
});

test('backend de CPU sem threads retorna null', () => {
  assert.equal(parseCpuThreads([{ type: 'cpu', profile: 'rx' }]), null);
});

test('inicializacao em andamento nao informa contagem', () => {
  // durante o start o XMRig publica threads parcialmente e sem perfil
  assert.equal(parseCpuThreads([{ type: 'cpu', profile: '', threads: [{ affinity: 0 }] }]), null);
  assert.equal(parseCpuThreads([{ type: 'cpu', threads: [{ affinity: 0 }] }]), null);
});

test('resposta inesperada nao quebra', () => {
  assert.equal(parseCpuThreads(null), null);
  assert.equal(parseCpuThreads({ error: 'unauthorized' }), null);
});
