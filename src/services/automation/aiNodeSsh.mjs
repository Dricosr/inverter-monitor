import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Executa um comando no ai-node por SSH e traduz o erro para algo util na tela.
 *
 * O `execFile` devolve `Command failed: ssh -o ... <comando inteiro>`; isso nao ajuda
 * em nada no painel. Fica aqui porque o executor de mineracao e o de energia precisam
 * do mesmo tratamento — mensagens diferentes para o mesmo problema confundem.
 */
export function createSshRunner(host = 'ai-node', {
  run = execute,
  connectTimeout = 8,
  timeoutMs = 30_000,
} = {}) {
  const baseArgs = ['-o', 'BatchMode=yes', `-o`, `ConnectTimeout=${connectTimeout}`, host];

  return async function ssh(command, { timeout = timeoutMs, allowFailure = false } = {}) {
    try {
      const { stdout } = await run('ssh', [...baseArgs, command], { windowsHide: true, timeout });
      return stdout;
    } catch (error) {
      if (allowFailure) return '';
      throw new Error(describeHostError(error, host));
    }
  };
}

export function describeHostError(error, host) {
  const stderr = String(error?.stderr ?? '');
  const message = String(error?.message ?? error);
  const both = `${stderr} ${message}`;
  if (/timed out|timeout/i.test(both) || /ETIMEDOUT/.test(message)) {
    return `${host} nao respondeu a tempo (timeout)`;
  }
  if (/Permission denied|publickey/i.test(both)) {
    return `${host} recusou a chave SSH`;
  }
  if (/Could not resolve|Name or service not known/i.test(both)) {
    return `${host} nao encontrado na rede`;
  }
  const detail = (stderr.trim() || message).split('\n')[0];
  return `${host}: ${detail}`;
}
