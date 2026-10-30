import { describeNetworkError } from '../../domain/networkError.mjs';

export class GateActionExecutor {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async apply(target, _desiredIntensity, context = {}) {
    const status = await this.#status();
    const gate = status?.gate ?? {};
    const paused = gate.paused === true;

    if (target === 'active') {
      if (paused) {
        return {
          changed: false,
          applied: true,
          owned: gate.pausedBy === 'manual',
          detail: `fila ja pausada (${gate.pausedBy ?? 'origem desconhecida'})`,
          pausedAt: gate.pausedAt ?? null,
        };
      }
      await this.#request('/v1/admin/pausar', 'POST');
      const after = await this.#status();
      if (after?.gate?.paused !== true) throw new Error('Gate nao confirmou a pausa da fila');
      return {
        changed: true,
        applied: true,
        owned: true,
        detail: 'fila pausada',
        pausedAt: after.gate.pausedAt ?? null,
      };
    }

    if (!paused) {
      return { changed: false, applied: false, owned: false, detail: 'fila ja executando' };
    }

    const ownedAt = context?.previous?.pausedAt ?? null;
    if (!ownedAt || gate.pausedAt !== ownedAt) {
      return {
        changed: false,
        applied: false,
        owned: false,
        conflict: true,
        detail: 'pausa criada por outro operador; nao retomando',
      };
    }

    await this.#request('/v1/admin/retomar', 'POST');
    const after = await this.#status();
    if (after?.gate?.paused === true) throw new Error('Gate nao confirmou a retomada da fila');
    return { changed: true, applied: false, owned: false, detail: 'fila retomada' };
  }

  async #status() {
    return this.#request('/v1/status');
  }

  async #request(path, method = 'GET') {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(4000),
      });
    } catch (error) {
      throw new Error(describeNetworkError(error, 'Gate'));
    }
    if (!response.ok) throw new Error(`Gate retornou HTTP ${response.status}`);
    return response.json();
  }
}
