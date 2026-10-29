export class RuleEngine {
  evaluate(rule, devices, executionEnabled = false) {
    const source = devices.find((device) => device.id === rule.sourceDeviceId);
    if (!rule.enabled || !source || !Number.isFinite(source.soc)) {
      return this.#result(rule, source, null, 'indeterminate', executionEnabled);
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

  #result(rule, source, soc, state, executionEnabled) {
    return {
      ruleId: rule.id,
      action: rule.action,
      enabled: rule.enabled === true,
      sourceDeviceId: rule.sourceDeviceId,
      sourceName: source?.name ?? null,
      sourceSoc: soc,
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
