import { connect } from 'node:net';
import { createSshRunner } from './aiNodeSsh.mjs';
import { sendMagicPacket } from '../../domain/wakeOnLan.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Porta SSH aberta = maquina ligada. Mais leve e rapido que disparar um `ssh`. */
function tcpReachable(address, port = 22, timeoutMs = 2_500) {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Liga e desliga o ai-node, com o caminho de volta garantido.
 *
 * Desligar e uma via de mao unica: se o Wake-on-LAN nao estiver armado na placa, a
 * maquina so volta com alguem apertando o botao. Por isso `desligar` **confirma o
 * armamento do WOL antes** e, se nao conseguir confirmar, nao desliga nada — falhar
 * sem desligar e aceitavel, desligar sem poder religar nao e.
 */
export class AiNodePowerActionExecutor {
  constructor({
    host = 'ai-node',
    address = '192.168.18.150',
    mac = null,
    iface = 'enp8s0',
    broadcast = '192.168.18.255',
    wolPort = 9,
    ssh = createSshRunner(host),
    sendWol = sendMagicPacket,
    isReachable = () => tcpReachable(address),
    sleep = wait,
    poweroffTimeoutMs = 90_000,
    bootTimeoutMs = 180_000,
    pollMs = 3_000,
  } = {}) {
    this.host = host;
    this.address = address;
    this.mac = mac;
    this.iface = iface;
    this.broadcast = broadcast;
    this.wolPort = wolPort;
    this.ssh = ssh;
    this.sendWol = sendWol;
    this.isReachable = isReachable;
    this.sleep = sleep;
    this.poweroffTimeoutMs = poweroffTimeoutMs;
    this.bootTimeoutMs = bootTimeoutMs;
    this.pollMs = pollMs;
  }

  /**
   * `active` = desligar (SOC baixo), `inactive` = religar (SOC recuperado).
   *
   * Desligar custa caro: o Gate roda no mesmo host. Ligar e o caminho de volta.
   */
  async apply(target) {
    if (target === 'active') return this.#powerOff();
    return this.#powerOn();
  }

  async #powerOff() {
    if (!this.mac || !this.broadcast) {
      throw new Error('Wake-on-LAN nao configurado: nao desligo o ai-node sem poder religa-lo');
    }
    if (!(await this.isReachable())) {
      return {
        changed: false, applied: true, owned: true,
        detail: 'ai-node ja estava desligado',
      };
    }

    const armed = await this.#armWakeOnLan();
    if (!armed) {
      throw new Error(
        `Wake-on-LAN nao confirmado em ${this.iface}: desligar deixaria o ai-node sem volta`);
    }

    // O comando derruba a propria conexao: a queda do SSH aqui e o esperado.
    await this.ssh('sudo -n systemctl poweroff', { allowFailure: true, timeout: 15_000 });

    const down = await this.#waitFor(async () => !(await this.isReachable()), this.poweroffTimeoutMs);
    if (!down) {
      throw new Error(`ai-node nao desligou em ${Math.round(this.poweroffTimeoutMs / 1000)}s`);
    }
    return {
      changed: true, applied: true, owned: true,
      detail: `ai-node desligado (Wake-on-LAN armado em ${this.iface})`,
    };
  }

  async #powerOn() {
    if (await this.isReachable()) {
      return { changed: false, applied: false, owned: false, detail: 'ai-node ja estava ligado' };
    }

    const result = await this.sendWol({
      mac: this.mac, address: this.broadcast, port: this.wolPort, repeat: 3,
    });
    if (!result?.sent) {
      throw new Error('nao foi possivel enviar o pacote do Wake-on-LAN');
    }

    const up = await this.#waitFor(() => this.isReachable(), this.bootTimeoutMs);
    if (!up) {
      throw new Error(
        `Wake-on-LAN enviado (${result.sent}x) mas o ai-node nao voltou em `
        + `${Math.round(this.bootTimeoutMs / 1000)}s · confira o Wake-on-LAN na BIOS/UEFI`);
    }
    return {
      changed: true, applied: false, owned: false,
      detail: 'ai-node religado por Wake-on-LAN',
    };
  }

  /** Liga o WOL na placa e **le de volta** para confirmar. */
  async #armWakeOnLan() {
    await this.ssh(`sudo -n ethtool -s ${this.iface} wol g`, { allowFailure: true, timeout: 15_000 });
    const status = await this.ssh(`sudo -n ethtool ${this.iface}`, { allowFailure: true, timeout: 15_000 });
    return /^\s*Wake-on:\s*g\s*$/im.test(status);
  }

  async #waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await this.sleep(this.pollMs);
    }
    return predicate();
  }
}
