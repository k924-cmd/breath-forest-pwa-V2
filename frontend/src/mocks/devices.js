export const DEVICE_CATALOG = [
  { id: 'fresh', type: 'fresh_air', name: '新风系统', room: '全屋', icon: 'wind', controlSupport: 'not_integrated', defaultState: 'unknown' },
  { id: 'purifier', type: 'air_purifier', name: '空气净化器', room: '客厅', icon: 'spark', controlSupport: 'supported', defaultState: 'on' },
  { id: 'humidifier', type: 'humidifier', name: '加湿器', room: '卧室', icon: 'drop', controlSupport: 'not_integrated', defaultState: 'unknown' },
  { id: 'window', type: 'smart_window', name: '智能窗户', room: '客厅', icon: 'window', controlSupport: 'supported', defaultState: 'closed' },
  { id: 'hood', type: 'range_hood', name: '抽油烟机', room: '厨房', icon: 'filter', controlSupport: 'supported', defaultState: 'off' },
  { id: 'fan', type: 'circulation_fan', name: '循环风机', room: '客厅', icon: 'fan', controlSupport: 'not_integrated', defaultState: 'unknown' }
];

export function sortDevicesByConnection(devices) {
  if (!Array.isArray(devices)) return [];
  return [...devices].sort((a, b) => {
    const rank = device => device?.connectionStatus === 'online' ? 0 : 1;
    return rank(a) - rank(b);
  });
}

export function createMockDevices() {
  const observedAt = new Date().toISOString();
  return sortDevicesByConnection(DEVICE_CATALOG.map(device => ({
    id: device.id,
    type: device.type,
    name: device.name,
    aliases: [],
    room: device.room,
    connectionStatus: device.controlSupport === 'supported' ? 'online' : 'unavailable',
    controlSupport: device.controlSupport,
    availableActions: device.controlSupport === 'supported'
      ? (device.type === 'smart_window' ? ['open', 'close'] : ['turn_on', 'turn_off'])
      : [],
    state: device.defaultState,
    stateVersion: 0,
    observedAt,
    source: 'mock',
    uiMockOnly: true
  })));
}

export function getDeviceMeta(device) {
  return DEVICE_CATALOG.find(item => item.type === device?.type)
    || DEVICE_CATALOG.find(item => item.id === device?.id)
    || { id: 'unknown', icon: 'devices', type: device?.type || 'unknown' };
}

export function findDevice(deviceId, devices = []) {
  return devices.find(device => device.id === deviceId) || null;
}

export function normalizeBackendDevices(devices) {
  if (!Array.isArray(devices)) return [];
  return sortDevicesByConnection(devices.filter(device => device && typeof device.id === 'string').map(device => ({ ...device, uiMockOnly: false })));
}
