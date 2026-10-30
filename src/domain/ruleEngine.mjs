export class RuleEngine {
  evaluate(rule, devices, executionEnabled = false) {
    const source = devices.find((device) => device.id === rule.sourceDeviceId);
    // SOC vindo do cache nao decide nada: o painel mostra o ultimo valor valido em
    // cinza, mas a automacao nao pode agir sobre uma leitura velha como se fosse agora.
    const stale = Boolean(source) && (source.online === false
      || Object.prototype.hasOwnProperty.call(source.stale?.fields ?? {}, 'battery.soc'));
    if (!rule.enabled || !source || !Number.isFinite(source.soc) || stale) {
      return this.#result(rule, source, null, 'indeterminate', executionEnabled, stale);
    }

    const soc = source.soc;
    const activateBelow = this.#clamp(rule.activateBelow ?? 50, 0, 100);
    const resumeAbove = this.#clamp(rule.resumeAbove ?? 55, 0, 100);

    if (soc < activateBelow) {
      return this.#result(rule, source, soc, 'active', executionEnabled);
    }
    if (soc >= resumeAbove) {
      return this.#result(rule, source, soc, 'inactive', executionEnabled);
    }
    return this.#result(rule, source, soc, 'hysteresis', executionEnabled);
  }

  evaluateAll(rules, devices, executionEnabled = false) {
    return rules.map((rule) => this.evaluate(rule, devices, executionEnabled));
  }

  #result(rule, source, soc, state, executionEnabled, stale = false) {
    return {
      ruleId: rule.id,
      action: rule.action,
      enabled: rule.enabled === true,
      sourceDeviceId: rule.sourceDeviceId,
      sourceName: source?.name ?? null,
      sourceSoc: soc,
      sourceStale: stale,
      state,
      desiredIntensity: rule.desiredIntensity ?? null,
      executionEnabled,
      wouldExecute: rule.enabled === true && executionEnabled && state === 'active',
    };
  }

  #clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || min));
  }
}
