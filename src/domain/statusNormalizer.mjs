export class StatusNormalizer {
  normalize(raw, devicesConfig) {
    const timestamp = raw?.timestamp ?? null;
    const deviceMap = raw?.devices && typeof raw.devices === 'object' ? raw.devices : {};
    const configured = Array.isArray(devicesConfig) ? devicesConfig : [];
    const ids = configured.map((device) => device.name).filter(Boolean);

    return ids.map((id) => {
      const device = deviceMap[id] ?? {};
      const settings = configured.find((item) => item.name === id) ?? {};
      const pv = this.#object(device.pv);
      const battery = this.#object(device.battery);
      const output = this.#object(device.output);
      const grid = this.#object(device.grid);

      const soc = this.#finite(battery.soc, null);
      const activePower = this.#finite(output.active_power, null);
      const batteryPower = this.#finite(battery.power, null);

      return {
        id,
        name: settings.displayName || settings.name || id,
        ip: device.ip ?? settings.ip ?? null,
        protocol: device.protocol ?? settings.protocol ?? null,
        online: device.online !== false,
        lastOk: device.last_ok ?? null,
        error: device.error ?? null,
        fresh: Boolean(timestamp),
        timestamp,
        mode: device.mode ?? null,
        soc,
        battery: {
          voltage: this.#finite(battery.voltage, null),
          current: this.#finite(battery.current, null),
          power: batteryPower,
          temperature: this.#finite(battery.temperature, this.#finite(this.#object(device.temperature).battery, null)),
        },
        pv: {
          voltage: this.#finite(pv.voltage, null),
          current: this.#finite(pv.current, null),
          power: this.#finite(pv.power, null),
          powerEstimated: this.#finite(pv.power_estimated, null),
        },
        grid: {
          voltage: this.#finite(grid.voltage, null),
          frequency: this.#finite(grid.frequency, null),
          power: this.#finite(grid.power, null),
        },
        output: {
          voltage: this.#finite(output.voltage, null),
          current: this.#finite(output.current, null),
          frequency: this.#finite(output.frequency, null),
          activePower,
          apparentPower: this.#finite(output.apparent_power, null),
        },
        loadPercent: this.#finite(device.load_percent, null),
        temperature: {
          inverter: this.#finite(this.#object(device.temperature).inverter, null),
          dcdc: this.#finite(this.#object(device.temperature).dcdc, null),
        },
      };
    });
  }

  #object(value) {
    return value && typeof value === 'object' ? value : {};
  }

  #finite(value, fallback = Number.NaN) {
    // Number(null) e Number('') valem 0: sem esta guarda um campo ausente viraria
    // "0 W" na tela, que e mentira (ausente != zero).
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
