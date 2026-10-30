import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  constructor(filePath, fallback, { logger = console } = {}) {
    this.filePath = filePath;
    this.fallback = fallback;
    this.logger = logger;
  }

  async read() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(this.fallback);
      throw error;
    }

    try {
      return JSON.parse(stripNulls(raw));
    } catch (error) {
      // Encerrar o processo no meio da escrita deixa o arquivo preenchido com NUL.
      // O estado e descartavel: preserva o arquivo para diagnostico e recomeca, em
      // vez de derrubar o painel inteiro por causa de um arquivo de cache.
      await this.#quarantine();
      this.logger.warn?.(`[store] ${path.basename(this.filePath)} ilegivel (${error.message}); usando o padrao`);
      return structuredClone(this.fallback);
    }
  }

  async write(value) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await rename(temporary, this.filePath);
  }

  async #quarantine() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await rename(this.filePath, `${this.filePath}.corrupt-${stamp}`);
    } catch {
      // se nao der para mover, a proxima escrita sobrescreve
    }
  }
}

function stripNulls(value) {
  return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
}
