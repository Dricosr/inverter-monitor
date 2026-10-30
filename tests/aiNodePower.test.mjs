import test from 'node:test';
import assert from 'node:assert/strict';
import { magicPacket, sendMagicPacket } from '../src/domain/wakeOnLan.mjs';
import { AiNodePowerActionExecutor } from '../src/services/automation/aiNodePowerActionExecutor.mjs';

const MAC = '00:e0:27:42:70:5b';

test('pacote magico do Wake-on-LAN', () => {
  const packet = magicPacket(MAC);
  assert.equal(packet.length, 102, '6 de cabecalho + 16 x 6 do MAC');
  assert.deepEqual([...packet.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const mac = Buffer.from('00e02742705b', 'hex');
  for (let index = 0; index < 16; index += 1) {
    assert.deepEqual([...packet.subarray(6 + index * 6, 12 + index * 6)], [...mac]);
  }
});

test('MAC invalido nao vira pacote', () => {
  assert.throws(() => magicPacket('00:e0:27'), /MAC invalido/);
  assert.throws(() => magicPacket(null), /MAC invalido/);
});

test('envia varias vezes e nao explode se o socket falhar', async () => {
  const enviados = [];
  const fakeSocket = () => ({
    once() {},
    bind(cb) { cb(); },
    setBroadcast() {},
    send(packet, offset, length, port, address, cb) {
      enviados.push({ length, port, address });
      cb(null);
    },
    close() {},
  });

  const result = await sendMagicPacket({
    mac: MAC, address: '192.168.18.255', port: 9, repeat: 3,
    createSocketImpl: fakeSocket, intervalMs: 0,
  });
  assert.equal(result.sent, 3, 'um pacote perdido nao pode custar a maquina');
  assert.equal(enviados.length, 3);
  assert.equal(enviados[0].port, 9);
  assert.equal(enviados[0].address, '192.168.18.255');

  const failing = await sendMagicPacket({
    mac: MAC, address: '192.168.18.255', repeat: 2, intervalMs: 0,
    createSocketImpl: () => ({
      once(event, handler) { if (event === 'error') handler(new Error('sem rede')); },
      bind() {}, setBroadcast() {}, send() {}, close() {},
    }),
  });
  assert.equal(failing.sent, 0);
});

function executor({ up = false, wolStatus = 'Wake-on: g', reachableSequence = null } = {}) {
  const calls = [];
  const reachability = reachableSequence ? [...reachableSequence] : null;
  const instance = new AiNodePowerActionExecutor({
    host: 'ai-node',
    address: '192.168.18.150',
    mac: MAC,
    iface: 'enp8s0',
    broadcast: '192.168.18.255',
    ssh: async (command) => {
      calls.push(command);
      if (command.includes('ethtool enp8s0') && !command.includes('-s')) {
        return `Settings for enp8s0:\n\tSupports Wake-on: pumbg\n\t${wolStatus}\n`;
      }
      return '';
    },
    sendWol: async () => ({ sent: 3 }),
    isReachable: async () => {
      if (reachability) return reachability.length ? reachability.shift() : up;
      return up;
    },
    sleep: async () => {},
    pollMs: 1,
    poweroffTimeoutMs: 50,
    bootTimeoutMs: 50,
  });
  return { instance, calls };
}

test('desligar arma o Wake-on-LAN e confirma que o host caiu', async () => {
  const { instance, calls } = executor({ reachableSequence: [true, true, false, false, false, false] });
  const result = await instance.apply('active');
  assert.equal(result.changed, true);
  assert.equal(result.applied, true);
  assert.match(result.detail, /Wake-on-LAN armado/);
  assert.ok(calls.some((command) => command.includes('ethtool -s enp8s0 wol g')), 'armou antes de desligar');
  assert.ok(calls.some((command) => command.includes('systemctl poweroff')));
});

test('sem Wake-on-LAN confirmado, nao desliga nada', async () => {
  const { instance, calls } = executor({ up: true, wolStatus: 'Wake-on: d' });
  await assert.rejects(() => instance.apply('active'), /Wake-on-LAN nao confirmado/);
  assert.ok(!calls.some((command) => command.includes('poweroff')),
    'desligar sem volta garantida nao pode acontecer');
});

test('desligar quando ja esta desligado nao faz nada', async () => {
  const { instance, calls } = executor({ up: false });
  const result = await instance.apply('active');
  assert.equal(result.changed, false);
  assert.equal(result.applied, true);
  assert.equal(calls.length, 0, 'nem chega a rodar SSH');
});

test('religar manda o pacote e espera o host voltar', async () => {
  const { instance } = executor({ reachableSequence: [false, false, false, true] });
  const result = await instance.apply('inactive');
  assert.equal(result.changed, true);
  assert.equal(result.applied, false);
  assert.match(result.detail, /Wake-on-LAN/);
});

test('religar quando ja esta ligado nao manda pacote', async () => {
  const { instance } = executor({ up: true });
  const result = await instance.apply('inactive');
  assert.equal(result.changed, false);
  assert.match(result.detail, /ja estava ligado/);
});

test('host que nao volta avisa que o WOL pode estar desligado na BIOS', async () => {
  const { instance } = executor({ up: false });
  await assert.rejects(() => instance.apply('inactive'), /BIOS\/UEFI/);
});
