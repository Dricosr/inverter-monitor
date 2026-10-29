import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.fallback = fallback;
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return structuredClone(this.fallback);
      }
      throw error;
    }
  }

  async write(value) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await rename(temporary, this.filePath);
  }
}
