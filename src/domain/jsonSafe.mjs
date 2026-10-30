/** JSON.parse que nunca lanca: o coletor grava o snapshot em disco e um encerramento
 *  no meio da escrita pode deixar o arquivo truncado ou preenchido com NUL. */
export function parseJsonSafe(text, fallback) {
  if (typeof text !== 'string') return text ?? fallback;
  try {
    return JSON.parse(text.replace(/\u0000/g, ''));
  } catch {
    return fallback;
  }
}
