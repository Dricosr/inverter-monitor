/** Traduz falhas de rede para algo que faca sentido na tela.
 *  O `fetch` do Node devolve mensagens em ingles ("The operation was aborted due to
 *  timeout"), que nao ajudam quem esta olhando o painel. */
export function describeNetworkError(error, target) {
  if (!error) return `${target} sem resposta`;
  const name = error.name ?? '';
  const message = String(error.message ?? error);
  const timedOut = name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|aborted/i.test(message);
  if (timedOut) return `${target} nao respondeu a tempo (timeout)`;
  if (/ECONNREFUSED|fetch failed/i.test(message)) return `${target} recusou a conexao`;
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return `${target} nao encontrado na rede`;
  if (/EHOSTUNREACH|ENETUNREACH/i.test(message)) return `${target} inalcancavel na rede`;
  return `${target}: ${message}`;
}
