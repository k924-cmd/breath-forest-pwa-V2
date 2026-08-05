import { clone } from "../core/utils.js";

const initialDevices = [
  { id: "purifier-living", type: "air_purifier", name: "客厅空气净化器", aliases: ["空气净化器", "净化器", "客厅净化器", "purifier", "air purifier"], room: "客厅", connectionStatus: "online", controlSupport: "supported", availableActions: ["turn_on", "turn_off"], state: "off", stateVersion: 1, source: "mock" },
  { id: "window-living", type: "smart_window", name: "客厅智能窗户", aliases: ["智能窗户", "窗户", "窗", "window", "smart window"], room: "客厅", connectionStatus: "online", controlSupport: "supported", availableActions: ["open", "close"], state: "closed", stateVersion: 1, source: "mock" },
  { id: "hood-kitchen", type: "range_hood", name: "厨房抽油烟机", aliases: ["抽油烟机", "油烟机", "hood", "range hood"], room: "厨房", connectionStatus: "online", controlSupport: "supported", availableActions: ["turn_on", "turn_off"], state: "off", stateVersion: 1, source: "mock" },
  { id: "fresh-air", type: "fresh_air", name: "新风系统", aliases: ["新风", "新风系统"], room: "全屋", connectionStatus: "unavailable", controlSupport: "not_integrated", availableActions: [], state: "unknown", stateVersion: 0, source: "mock" },
  { id: "humidifier", type: "humidifier", name: "加湿器", aliases: ["加湿器"], room: "客厅", connectionStatus: "unavailable", controlSupport: "not_integrated", availableActions: [], state: "unknown", stateVersion: 0, source: "mock" },
  { id: "circulation-fan", type: "circulation_fan", name: "循环风机", aliases: ["循环风机", "循环扇"], room: "客厅", connectionStatus: "unavailable", controlSupport: "not_integrated", availableActions: [], state: "unknown", stateVersion: 0, source: "mock" },
];

export class InMemoryDeviceRegistry {
  constructor(devices = initialDevices, clock = { iso: () => new Date().toISOString() }) {
    this.clock = clock;
    this.devices = new Map(devices.map((device) => [device.id, { ...clone(device), observedAt: device.observedAt ?? clock.iso() }]));
  }
  list() { return [...this.devices.values()].map(clone); }
  get(id) { const value = this.devices.get(id); return value ? clone(value) : null; }
  replace(device) { this.devices.set(device.id, clone(device)); }
  updateState(id, state) {
    const device = this.devices.get(id);
    if (!device) return null;
    device.state = state;
    device.stateVersion += 1;
    device.observedAt = this.clock.iso();
    return clone(device);
  }
  resolve(text) {
    const normalized = String(text).toLowerCase().replace(/\s+/g, "");
    const matches = this.list().filter((device) => [device.name, ...device.aliases].some((alias) => normalized.includes(alias.toLowerCase().replace(/\s+/g, ""))));
    return matches;
  }
}

export function actionTarget(device, action) {
  if (device.type === "smart_window") {
    if (action === "open") return "open";
    if (action === "close") return "closed";
  } else {
    if (action === "turn_on") return "on";
    if (action === "turn_off") return "off";
  }
  return null;
}
