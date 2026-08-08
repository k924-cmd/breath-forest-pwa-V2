import { icon } from '../components/icons.js?v=20260808-2';
import { getDeviceMeta } from '../mocks/devices.js?v=20260808-2';
import { formatObservedAt, getConnectionPresentation, getDeviceStateLabel, getSourceLabel } from '../presentation.js?v=20260808-2';
import { escapeHtml } from '../utils/html.js?v=20260808-2';

function deviceCard(device, state) {
  const meta = getDeviceMeta(device);
  const grid = state.deviceView === 'grid';
  const controllable = device.controlSupport === 'supported';
  const active = ['on', 'open'].includes(device.state);
  const readOnly = state.connection.status === 'connected';
  const stateText = getDeviceStateLabel(device.state);
  return `<article class="device-card ${grid ? 'card-grid' : ''} ${controllable ? 'integrated' : 'not-integrated'}" data-device-detail="${escapeHtml(device.id)}" tabindex="0">
    ${grid ? `<span class="device-preview device-${meta.id}">${icon(meta.icon)}</span>` : ''}
    <span class="device-icon">${icon(meta.icon)}</span><div class="device-copy"><strong>${escapeHtml(device.name)}</strong><small>${escapeHtml(device.room)} · ${stateText}</small></div>
    <span class="device-dot ${device.connectionStatus === 'online' ? 'on' : ''}" title="${getSourceLabel(device.source)} · ${device.connectionStatus === 'online' ? '在线' : device.connectionStatus === 'offline' ? '离线' : '待接入'}"></span>
    <label class="switch" title="${readOnly ? '后端快照只读，请通过 AI 对话操作' : '仅切换本地 UI Mock'}"><input data-device="${escapeHtml(device.id)}" type="checkbox" ${active ? 'checked' : ''} ${controllable && !readOnly ? '' : 'disabled'} aria-label="${escapeHtml(device.name)}开关"><i></i></label>
  </article>`;
}

export function devicesPage(state) {
  const connection = getConnectionPresentation(state.connection);
  const viewLabel = state.deviceView === 'list' ? '切换为双列卡片' : '切换为单列列表';
  const latestObservedAt = state.devices.map(device => device.observedAt).filter(Boolean).sort().at(-1);
  return `<section class="page devices-page ${state.tab === 'devices' ? 'active' : ''}">
    <header class="page-header"><div><span class="eyebrow">AIRCARE SYSTEM</span><h1>设备与环境</h1><p>${connection.label}</p></div><div class="header-actions"><button class="circle-btn view-toggle" data-action="device-view" aria-label="${viewLabel}">${icon(state.deviceView === 'list' ? 'devices' : 'list')}</button><button class="circle-btn" data-action="logs" aria-label="操作日志">${icon('clock')}</button></div></header>
    <section class="system-brief glass connection-panel ${connection.tone}"><span class="brief-orb">${connection.icon}</span><div><b>${connection.label}</b><p>${connection.detail}</p></div><small>${formatObservedAt(latestObservedAt)}</small></section>
    <div class="device-list ${state.deviceView}">${state.devices.map(device => deviceCard(device, state)).join('')}</div>
    <section class="section-heading timeline-heading"><div><span class="eyebrow">ENVIRONMENT TIMELINE</span><h2>环境时间轴</h2></div><span>UI Mock 图表</span></section>
    <section class="environment-card glass"><div class="chart-top"><b>PM2.5 趋势</b><span>仅界面演示，不代表后端历史数据</span></div><svg viewBox="0 0 340 112" aria-label="UI Mock PM2.5 趋势图"><defs><linearGradient id="airFill" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#9fcbb6" stop-opacity=".56"/><stop offset="1" stop-color="#9fcbb6" stop-opacity="0"/></linearGradient></defs><path class="gridline" d="M0 25H340M0 58H340M0 91H340"/><path class="area" d="M0 80C25 66 43 83 70 62s42 8 70-12 46 24 69 8 48-10 70-26 37 12 61-5v85H0Z"/><path class="line" d="M0 80C25 66 43 83 70 62s42 8 70-12 46 24 69 8 48-10 70-26 37 12 61-5"/></svg><div class="chart-times"><span>08:00</span><span>12:00</span><span>16:00</span><span>现在</span></div></section>
  </section>`;
}
