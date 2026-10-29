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

      const soc = this.#finite(battery.soc);
      const pvPower = this.#finite(pv.power, null);
      const activePower = this.#finite(output.active_power, null);
      const batteryPower = this.#finite(battery.power, null);

      return {
        id,
        name: settings.displayName || settings.name || id,
        ip: device.ip ?? settings.ip ?? null,
        protocol: device.protocol ?? settings.protocol ?? null,
        online: device.online !== false,
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
          power: pvPower,
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
        temperature: this.#object(device.temperature),
      };
    });
  }

  #object(value) {
    return value && typeof value === 'object' ? value : {};
  }

  #finite(value, fallback = Number.NaN) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
