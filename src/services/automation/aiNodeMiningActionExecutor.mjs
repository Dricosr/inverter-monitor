import { describeNetworkError } from '../../domain/networkError.mjs';

/**
 * Mineração do ai-node: PEDIDO ao Gate, nunca comando remoto.
 *
 * Antes este executor abria SSH no ai-node e rodava
 * `sudo -n /usr/local/sbin/ainode-mining-mode normal`. Isso derrubava em segundos o
 * limite que o Gate tinha aplicado para ceder a CPU ao Strata — a mineração voltava
 * aos 28 threads no meio de uma inferência e o decode caía pela metade.
 *
 * Agora o monitor só DIZ o que a energia permite (`POST /v1/mining/intent`) e quem
 * decide continua sendo o Gate:
 *
 *   - IA rodando  -> o Gate mantém a mineração em 1 núcleo, mesmo que aqui peça "liberar";
 *   - IA parada   -> `allow:false` segura na cota pedida; `allow:true` libera;
 *   - o pedido vence sozinho (TTL do Gate): este monitor renova a cada avaliação,
 *     então se ele morrer a mineração volta ao padrão em vez de ficar travada.
 */
export class AiNodeMiningActionExecutor {
  constructor(baseUrl = 'http://192.168.18.150:3070', { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  // `desiredIntensity` (a % de 1 CPU que o painel antes pedia) não é mais usada: agora o
  // pedido é binário — parar ou liberar. Mantida na assinatura porque a automação chama
  // `apply(target, rule.desiredIntensity)`.
  async apply(target, _desiredIntensity) {
    const segurar = target === 'active';

    const antes = await this.#mining().catch(() => null);
    const governadorAntes = antes?.governor ?? null;
    const intentAntes = governadorAntes?.intent ?? null;
    // Antes pedia `quotaPercent` (reduzir). Medido no nó em 06/11/2026: mesmo com 1 núcleo
    // de cota o decode do Strata cai ~50% (17 → 9,3 tok/s) — a mineração disputa banda de
    // memória, não só CPU. Agora o pedido é PARAR (`stop: true`).
    const jaEstava = segurar ? intentAntes?.stop === true : intentAntes?.allow === true;

    const resposta = await this.#pedir({
      ...(segurar ? { allow: false, stop: true } : { allow: true }),
      reason: segurar ? 'energia: sem excedente para minerar' : 'energia: excedente liberado',
      source: 'inverter-monitor'
    });
    const governador = resposta?.governor ?? {};
    const paradoAgora = governador.stopped === true;
    const paradoAntes = governadorAntes?.stopped === true;
    const mudou = paradoAgora !== paradoAntes;

    return {
      changed: mudou,
      applied: true,
      owned: segurar,
      detail: this.#descreve(segurar, governador),
      gate: {
        mode: governador.mode ?? null,
        quotaPercent: governador.quotaAtual ?? null,
        stopped: governador.stopped ?? null,
        reason: governador.reason ?? null,
        aiWins: governador.mode === 'ai' && governador.stopped === true
      },
      jaEstava
    };
  }

  /** Texto para a tela: quem mandou agora é o Gate, não este app. */
  #descreve(segurar, governador) {
    const parado = governador.stopped === true;
    const motivo = governador.reason ? ` — ${governador.reason}` : '';
    if (parado) return `mineracao PARADA pelo Gate${motivo}`;
    if (segurar) return `pedido ao Gate: parar a mineracao (ela segue rodando: ${governador.quotaAtual ?? 'livre'})`;
    return `pedido ao Gate: liberar (mineracao: ${governador.quotaAtual ?? 'livre'})`;
  }

  async #mining() {
    return this.#request('/v1/mining');
  }

  async #pedir(corpo) {
    return this.#request('/v1/mining/intent', 'POST', corpo);
  }

  async #request(path, method = 'GET', body = null) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new Error(describeNetworkError(error, 'Gate'));
    }
    if (!response.ok) {
      let detalhe = '';
      try {
        const erro = await response.json();
        detalhe = erro?.detail ?? erro?.error ?? '';
      } catch {
        // corpo nao-JSON: fica so o status
      }
      throw new Error(`Gate retornou HTTP ${response.status}${detalhe ? ` (${detalhe})` : ''}`);
    }
    return response.json();
  }
}
