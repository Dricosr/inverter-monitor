export class GateActionExecutor {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async apply(target) {
    const status = await this.#request('/v1/status');
    const paused = status?.gate?.paused === true || status?.paused === true;
    const shouldPause = target === 'active';
    if (paused === shouldPause) return { changed: false, detail: shouldPause ? 'fila ja pausada' : 'fila ja executando' };

    await this.#request(shouldPause ? '/v1/admin/pausar' : '/v1/admin/retomar', 'POST');
    return { changed: true, detail: shouldPause ? 'fila pausada' : 'fila retomada' };
  }

  async #request(path, method = 'GET') {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`Gate retornou HTTP ${response.status}`);
    return response.json();
  }
}
