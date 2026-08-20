import { icon } from '../components/icons.js?v=20260808-19';
import { getConnectionPresentation } from '../presentation.js?v=20260808-19';
import { escapeHtml } from '../utils/html.js?v=20260808-19';

function realtimeBadge(realtime) {
  const live = Boolean(realtime?.available);
  return `<span class="home-realtime ${live ? 'live' : ''}" title="${live ? '已接入实时搜索引擎' : '未配置实时引擎，使用本地模拟'}"><i></i>${live ? '实时情况' : '实时情况 · 本地模拟'}</span>`;
}

const WEATHER_ICONS = { sun: '☀', cloud: '☁', rain: '🌧', snow: '❄', wind: '🌬' };

function weatherBlock(weather, profile) {
  const data = weather?.available === true ? weather : { temp: '26', condition: '晴', icon: 'sun' };
  const glyph = WEATHER_ICONS[data.icon] || WEATHER_ICONS.sun;
  const city = (data.city && data.city.trim()) || profile?.city || '';
  const cityHtml = city ? `<span class="weather-city">${escapeHtml(city)}</span>` : '';
  return `<div class="home-weather"><span class="weather-icon">${glyph}</span><div class="weather-meta">${cityHtml}<b>${escapeHtml(data.temp)}℃</b><span>${escapeHtml(data.condition)}</span></div></div><p class="weather-greeting">愿您每一次呼吸都清新自在！</p>`;
}

export function homePage(state, environment, realtime = state.realtime, weather = null) {
  const connection = getConnectionPresentation(state.connection);
  const hasEnvironment = Boolean(environment);
  const metric = key => hasEnvironment ? escapeHtml(environment[key]) : '--';
  return `<section class="page home-page ${state.tab === 'home' ? 'active' : ''}">
    <section class="home-hero">
      <div class="hero-scrim"></div>
      <header class="home-header"><div class="home-title"><span class="eyebrow">Welcome!</span><h1>${escapeHtml(state.profile.home)}</h1>${weatherBlock(weather, state.profile)}</div><div class="home-header-side"><span class="side-spacer"></span>${realtimeBadge(realtime)}</div></header>
      <div class="home-bot"><button class="luna-walker" data-action="luna" aria-label="呼唤 Luna" aria-expanded="false"><span class="luna-bounce"><div id="lottie-stage" role="img" aria-label="AI 助手机器人"></div></span></button></div>
      <div class="home-note"><b>Hi，我是 Luna</b><small>${escapeHtml(connection.label)}</small></div>
    </section>
    <section class="home-cards">
      <div class="air-card home-data-card"><div class="air-score"><b>${metric('score')}</b><span>${hasEnvironment ? escapeHtml(environment.status) : '数据不可用'}</span></div><div class="air-detail"><div><span>PM2.5</span><b>${metric('pm25')} <small>μg/m³</small></b></div><div><span>CO₂</span><b>${metric('co2')} <small>ppm</small></b></div><div><span>湿度</span><b>${metric('humidity')}<small>%</small></b></div></div></div>
      <div class="scene-grid"><button data-scene="回家模式"><span>${icon('home')}</span><b>回家</b></button><button data-scene="深呼吸模式"><span>${icon('wind')}</span><b>深呼吸</b></button><button data-scene="睡眠模式"><span>${icon('leaf')}</span><b>静享</b></button><button data-scene="低碳模式"><span>${icon('spark')}</span><b>低碳</b></button></div>
    </section>
  </section>`;
}
