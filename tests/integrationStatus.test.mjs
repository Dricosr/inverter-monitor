import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAiNodeHashrate } from '../src/services/integrationStatus.service.mjs';

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
