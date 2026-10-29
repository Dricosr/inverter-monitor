export class RuleEngine {
  evaluate(rule, devices) {
    const source = devices.find((device) => device.id === rule.sourceDeviceId);
    if (!rule.enabled || !source || !Number.isFinite(source.soc)) {
      return this.#result(rule, source, null, 'indeterminate');
    }

    const soc = source.soc;
    const activateBelow = this.#clamp(rule.activateBelow ?? 50, 0, 100);
    const resumeAbove = this.#clamp(rule.resumeAbove ?? 55, 0, 100);

    if (soc < activateBelow) {
      return this.#result(rule, source, soc, 'active');
    }
    if (soc >= resumeAbove) {
      return this.#result(rule, source, soc, 'inactive');
    }
    return this.#result(rule, source, soc, 'hysteresis');
  }

  evaluateAll(rules, devices) {
    return rules.map((rule) => this.evaluate(rule, devices));
  }

  #result(rule, source, soc, state) {
    return {
      ruleId: rule.id,
      action: rule.action,
      enabled: rule.enabled === true,
      sourceDeviceId: rule.sourceDeviceId,
      sourceName: source?.name ?? null,
      sourceSoc: soc,
      state,
      desiredIntensity: rule.desiredIntensity ?? null,
      executionEnabled: false,
      wouldExecute: rule.enabled === true && state === 'active',
    };
  }

  #clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || min));
  }
}
