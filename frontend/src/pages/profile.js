import { icon } from '../components/icons.js?v=20260807-2';
import { getConnectionPresentation } from '../presentation.js?v=20260807-2';
import { escapeHtml } from '../utils/html.js?v=20260807-2';

export function profilePage(state) {
  const avatar = state.profile.avatar ? `<img src="${state.profile.avatar}" alt="${escapeHtml(state.profile.name)}">` : icon('leaf');
  const connection = getConnectionPresentation(state.connection);
  return `<section class="page profile-page ${state.tab === 'profile' ? 'active' : ''}"><header class="page-header"><div><span class="eyebrow">MY FOREST</span><h1>我的森林</h1><p>${connection.icon} ${connection.label}</p></div></header><section class="profile-hero glass"><span class="profile-mark">${avatar}</span><div><b>${escapeHtml(state.profile.name)}</b><p>${escapeHtml(state.profile.home)} · UI 演示空间</p></div><button data-action="profile">编辑资料 ${icon('arrow')}</button></section><section class="achievement"><span class="eyebrow">DEMO DATA · 仅界面演示</span><h2>呼吸成就</h2><div><article><b>2.4</b><span>度演示数值</span></article><article><b>5.8</b><span>kg 演示数值</span></article><article><b>28</b><span>天演示数值</span></article></div></section><section class="setting-list glass"><button data-action="home-detail">${icon('home')} ${escapeHtml(state.profile.home)} ${icon('arrow')}</button><button data-action="notice-detail">${icon('chat')} 通知提醒 · ${escapeHtml(state.profile.reminder)} ${icon('arrow')}</button><button data-action="energy-detail">${icon('leaf')} 我的能量树 ${icon('arrow')}</button><button data-action="about-detail">${icon('more')} 关于呼吸森林 ${icon('arrow')}</button></section></section>`;
}
