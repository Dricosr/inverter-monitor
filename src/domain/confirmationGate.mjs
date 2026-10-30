/**
 * Portao de confirmacao das automacoes.
 *
 * O gatilho (SOC abaixo de X) nao age na primeira leitura: ele precisa se manter por
 * `confirmSeconds`. Uma nuvem que passa, um pico de consumo ou uma leitura ruim nao
 * podem desligar uma maquina. A mesma espera vale para a volta, senao o equipamento
 * liga e desliga a cada oscilacao.
 *
 * Regras:
 *  - leitura nao confiavel (target nulo) **cancela** a contagem — nao pausa, nao
 *    aproveita o tempo anterior;
 *  - inverter o alvo (ligar <-> desligar) tambem recomeca a contagem;
 *  - `confirmSeconds = 0` age imediatamente (comportamento antigo).
 *
 * `now` em milissegundos; `pending.since` em ISO-8601 para sobreviver a um reinicio.
 */
export function advanceConfirmation({ target, pending = null, now, confirmSeconds = 0 }) {
  if (!target) {
    return { action: 'cancel', pending: null, waitedSeconds: 0, remainingSeconds: 0 };
  }
  const seconds = Math.max(0, Math.floor(Number(confirmSeconds) || 0));
  if (seconds === 0) {
    return { action: 'act', pending: null, waitedSeconds: 0, remainingSeconds: 0 };
  }
  if (!pending || pending.target !== target || !Number.isFinite(Date.parse(pending.since))) {
    return {
      action: 'wait',
      pending: { target, since: new Date(now).toISOString() },
      waitedSeconds: 0,
      remainingSeconds: seconds,
    };
  }
  const waited = Math.max(0, Math.round((now - Date.parse(pending.since)) / 1000));
  if (waited >= seconds) {
    return { action: 'act', pending: null, waitedSeconds: waited, remainingSeconds: 0 };
  }
  return { action: 'wait', pending, waitedSeconds: waited, remainingSeconds: seconds - waited };
}
