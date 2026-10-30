import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/services/jsonStore.service.mjs';
import { parseJsonSafe } from '../src/domain/jsonSafe.mjs';

const silent = { warn: () => {} };

test('le o arquivo quando ele esta integro', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'state.json');
  await writeFile(file, JSON.stringify({ actions: { a: 1 } }), 'utf8');

  const value = await new JsonStore(file, { actions: {} }, { logger: silent }).read();
  assert.deepEqual(value, { actions: { a: 1 } });
});

test('arquivo ausente devolve o padrao sem criar nada', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'store-'));
  const value = await new JsonStore(path.join(dir, 'nada.json'), { actions: {} }, { logger: silent }).read();
  assert.deepEqual(value, { actions: {} });
});

test('arquivo preenchido com NUL nao derruba o painel', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'state.json');
  await writeFile(file, '\u0000'.repeat(1303), 'utf8');

  const value = await new JsonStore(file, { actions: { safe: true } }, { logger: silent }).read();
  assert.deepEqual(value, { actions: { safe: true } });

  const names = await readdir(dir);
  assert.ok(names.some((name) => name.includes('.corrupt-')), 'arquivo ruim deve ser preservado');
});

test('JSON truncado tambem recupera', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'state.json');
  await writeFile(file, '{"actions": {"a": ', 'utf8');

  const value = await new JsonStore(file, { actions: {} }, { logger: silent }).read();
  assert.deepEqual(value, { actions: {} });
});

test('escrita continua atomica e legivel', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'state.json');
  const store = new JsonStore(file, {}, { logger: silent });

  await store.write({ actions: { x: 2 }, updatedAt: 'agora' });
  assert.deepEqual(await store.read(), { actions: { x: 2 }, updatedAt: 'agora' });
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('parseJsonSafe tolerancia', () => {
  assert.deepEqual(parseJsonSafe('{"a":1}', {}), { a: 1 });
  assert.deepEqual(parseJsonSafe('{"a"', {}), {});
  assert.deepEqual(parseJsonSafe('\u0000\u0000', {}), {});
  assert.deepEqual(parseJsonSafe(undefined, { ok: true }), { ok: true });
});
