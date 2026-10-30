import { createSocket } from 'node:dgram';

/**
 * Pacote magico do Wake-on-LAN: 6 bytes 0xFF seguidos do MAC repetido 16 vezes.
 *
 * Sem dependencia externa de proposito — o projeto so usa a stdlib no coletor e o
 * Express no painel.
 */
export function magicPacket(mac) {
  const hex = String(mac ?? '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) throw new Error(`MAC invalido para Wake-on-LAN: ${mac}`);
  const address = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * address.length, 0xff);
  for (let index = 0; index < 16; index += 1) {
    address.copy(packet, 6 + index * address.length);
  }
  return packet;
}

/**
 * Envia o pacote magico por UDP em broadcast, algumas vezes: um pacote perdido nao
 * pode ser a diferenca entre a maquina voltar ou ficar desligada.
 *
 * `createSocketImpl` existe para o teste nao abrir socket de verdade.
 */
export async function sendMagicPacket({
  mac,
  address,
  port = 9,
  repeat = 3,
  intervalMs = 300,
  createSocketImpl = createSocket,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const packet = magicPacket(mac);
  let sent = 0;
  for (let attempt = 0; attempt < Math.max(1, repeat); attempt += 1) {
    sent += await new Promise((resolve) => {
      const socket = createSocketImpl({ type: 'udp4' });
      const done = (result) => {
        try { socket.close(); } catch { /* ja fechado */ }
        resolve(result);
      };
      socket.once('error', () => done(0));
      try {
        socket.bind(() => {
          try {
            socket.setBroadcast(true);
            socket.send(packet, 0, packet.length, port, address, (error) => done(error ? 0 : 1));
          } catch {
            done(0);
          }
        });
      } catch {
        done(0);
      }
    });
    if (attempt < repeat - 1 && intervalMs) await wait(intervalMs);
  }
  return { sent, packetBytes: packet.length };
}
