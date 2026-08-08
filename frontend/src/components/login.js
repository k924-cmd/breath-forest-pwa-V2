import { icon } from '../components/icons.js?v=20260808-7';
import { escapeHtml } from '../utils/html.js?v=20260808-7';

export function loginPage() {
  return `<section class="login-overlay" aria-label="管理员登录">
    <form id="login-form" class="login-sheet glass">
      <header><span class="login-mark">${icon('leaf')}</span><span class="eyebrow">ADMIN GATE</span><h1>欢迎回来</h1><p>登录后进入呼吸森林</p></header>
      <label>管理员账号<input id="login-username" name="username" value="admin" maxlength="32" autocomplete="username" spellcheck="false"></label>
      <label>密码<input id="login-password" name="password" type="password" maxlength="64" autocomplete="current-password" placeholder="••••••"></label>
      <p id="login-error" class="login-error" role="alert"></p>
      <button class="login-submit" type="submit">进入呼吸森林 ${icon('arrow')}</button>
    </form>
  </section>`;
}
