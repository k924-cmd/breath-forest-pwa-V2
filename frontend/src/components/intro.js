import { escapeHtml } from '../utils/html.js?v=20260808-6';

export const INTRO_SLOGAN = '每一次呼吸，都在变好';
export const INTRO_SUBTITLE = '呼吸森林 · 陪你关照每一口空气';

export function introPage() {
  return `<section class="intro-overlay" aria-label="呼吸森林入场动画">
    <div id="intro-stage" class="intro-stage" role="img" aria-label="AI 助手机器人入场动画"></div>
    <h1 class="intro-slogan">${escapeHtml(INTRO_SLOGAN)}</h1>
    <p class="intro-subtitle">${escapeHtml(INTRO_SUBTITLE)}</p>
    <span class="intro-brand">呼吸森林</span>
  </section>`;
}
