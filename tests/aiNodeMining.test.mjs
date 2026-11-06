import test from 'node:test';
import assert from 'node:assert/strict';
import { AiNodeMiningActionExecutor } from '../src/services/automation/aiNodeMiningActionExecutor.mjs';

/**
 * O executor da mineração do ai-node NÃO fala mais SSH: ele manda um PEDIDO para o
 * Gate (`POST /v1/mining/intent`) e lê o estado por `GET /v1/mining`. Quem decide a
 * cota é o Gate (a IA sempre vence). Estes testes fixam esse contrato.
 */

/** `fetch` falso: guarda as chamadas e devolve respostas roteirizadas. */
function fakeFetch({ governor = {}, mining = { governor } } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null
    });
    const payload = (options.method ?? 'GET') === 'POST'
      ? { ok: true, governor: { ...governor, ...(options.body ? JSON.parse(options.body) : {}) } }
      : mining;
    return {
      ok: true,
      status: 200,
      json: async () => payload
    };
  };
  return { fetchImpl, calls };
}

test('segurar manda allow:false + stop:true (parada, nao reducao)', async () => {
  const { fetchImpl, calls } = fakeFetch({ governor: { mode: 'ai', stopped: true, reason: 'sem excedente' } });
  const executor = new AiNodeMiningActionExecutor('http://gate:3070', { fetchImpl });

  await executor.apply('active', 25);

  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.url, 'http://gate:3070/v1/mining/intent');
  assert.equal(post.body.allow, false);
  assert.equal(post.body.stop, true, 'para de vez: 1 nucleo ainda rouba ~50% do decode');
  assert.equal(post.body.quotaPercent, undefined, 'nao pede cota quando o pedido e parar');
  assert.equal(post.body.source, 'inverter-monitor');
  assert.match(post.body.reason, /sem excedente/);
});

test('liberar manda allow:true e nao manda quota', async () => {
  const { fetchImpl, calls } = fakeFetch({ governor: { mode: 'normal', quotaAtual: null } });
  const executor = new AiNodeMiningActionExecutor('http://gate:3070', { fetchImpl });

  await executor.apply('inactive', 25);

  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.allow, true);
  assert.equal(post.body.quotaPercent, undefined, 'sem contencao nao ha cota a pedir');
});

test('o pedido de parar e sempre o mesmo, qualquer que seja a intensidade do painel', async () => {
  const { fetchImpl, calls } = fakeFetch({ governor: { mode: 'ai', stopped: true } });
  const executor = new AiNodeMiningActionExecutor('http://gate:3070', { fetchImpl });

  await executor.apply('active', -5);
  await executor.apply('active', 400);
  await executor.apply('active', 0);

  const posts = calls.filter((c) => c.method === 'POST');
  for (const post of posts) {
    assert.equal(post.body.stop, true);
    assert.equal(post.body.allow, false);
  }
});

test('quando o Gate mantem a mineracao parada, o detalhe diz isso', async () => {
  const { fetchImpl } = fakeFetch({
    governor: { mode: 'ai', stopped: true, quotaAtual: null, reason: 'Strata gerando (thinking)' }
  });
  const executor = new AiNodeMiningActionExecutor('http://gate:3070', { fetchImpl });

  const resultado = await executor.apply('inactive', 25);

  assert.equal(resultado.gate.aiWins, true);
  assert.equal(resultado.gate.stopped, true);
  assert.match(resultado.detail, /PARADA/);
});

test('le o estado antes de pedir (para saber se a mineracao mudou de estado)', async () => {
  const { fetchImpl, calls } = fakeFetch({
    governor: { mode: 'ai', stopped: true, reason: 'pedido do monitor' }
  });
  const executor = new AiNodeMiningActionExecutor('http://gate:3070', { fetchImpl });

  const resultado = await executor.apply('active', 25);

  assert.equal(calls[0].url, 'http://gate:3070/v1/mining');
  assert.equal(calls[0].method, 'GET');
  assert.equal(resultado.changed, false, 'ja estava parada: nada mudou');
});

test('erro HTTP do Gate vira mensagem legivel', async () => {
  const executor = new AiNodeMiningActionExecutor('http://gate:3070', {
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_quota', detail: 'quotaPercent deve ser >= 0' })
    })
  });

  await assert.rejects(() => executor.apply('active', 25), /HTTP 400/);
});

test('gate fora do ar nao derruba a avaliacao com erro cru', async () => {
  const executor = new AiNodeMiningActionExecutor('http://gate:3070', {
    fetchImpl: async () => {
      const erro = new Error('fetch failed');
      erro.cause = { code: 'ECONNREFUSED' };
      throw erro;
    }
  });

  await assert.rejects(() => executor.apply('active', 25), (erro) => {
    assert.ok(!/fetch failed/.test(erro.message), 'traduz o erro de rede');
    return true;
  });
});
test('liberar nao marca applied: a regra precisa poder ficar alinhada', async () => {
  // `applied` significa "a automacao esta segurando o recurso". Deixar `true` na
  // liberacao fazia a regra nunca ficar alinhada e reabrir a janela de confirmacao a
  // cada ciclo (regra com confirmSeconds > 0 ficaria em "Confirmando" para sempre).
  const { fetchImpl } = fakeFetch({ governor: { mode: 'normal', quotaAtual: null } });
  const executor = new AiNodeMiningActionExecutor('http://gate:3070', { fetchImpl });

  const solto = await executor.apply('inactive', 20);
  assert.equal(solto.applied, false, 'liberado nao esta sendo segurado');
  assert.equal(solto.owned, false);

  const segurado = await executor.apply('active', 20);
  assert.equal(segurado.applied, true);
  assert.equal(segurado.owned, true);
});

