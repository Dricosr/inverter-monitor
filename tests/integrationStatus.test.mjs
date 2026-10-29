import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAiNodeHashrate, normalizeEp2Hashrate } from '../src/services/integrationStatus.service.mjs';

test('normaliza hashrate nested do Gate ai-node', () => {
  const normalized = normalizeAiNodeHashrate({
    hashRate: null,
    hashRate10s: null,
    hashrate: {
      now10s: 11407,
      now60s: 11360,
      now15m: 8157,
    },
  });

  assert.equal(normalized.hashrate, 11407);
  assert.equal(normalized.hashrate10s, 11407);
  assert.equal(normalized.hashrate60s, 11360);
  assert.equal(normalized.hashrate15m, 8157);
});

test('mantem compatibilidade com resposta escalar antiga', () => {
  assert.deepEqual(normalizeAiNodeHashrate({ hashrate: 9000 }), {
    hashrate: 9000,
    hashrate10s: 9000,
    hashrate60s: null,
    hashrate15m: null,
  });
});

test('normaliza as janelas de hashrate da EP2', () => {
  assert.deepEqual(normalizeEp2Hashrate([7970.35, 7940.5, 8017.73]), {
    hashrate: 7970.35,
    hashrate10s: 7970.35,
    hashrate60s: 7940.5,
    hashrate15m: 8017.73,
  });
});

test('EP2 sem hashrate nao inventa valores', () => {
  assert.deepEqual(normalizeEp2Hashrate(null), {
    hashrate: null,
    hashrate10s: null,
    hashrate60s: null,
    hashrate15m: null,
  });
});
