// 界面背景：一键更换首页背景。三态：
//   'default'             → 默认雾白纯色
//   'preset:<id>'         → 冷雾主题渐变（一键切换，不依赖上传）
//   'custom'              → 用户上传图（dataURL 独立存储，见 state.js）
// 背景铺满逻辑在 styles.css 的 .app.has-user-bg::before/::after。

export const BG_PRESETS = [
  {
    id: 'mist',
    name: '雾霭晨光',
    css: 'linear-gradient(160deg, #dbe6e7 0%, #b9cdd0 46%, #e8efef 100%)'
  },
  {
    id: 'glacier',
    name: '冰川蓝调',
    css: 'linear-gradient(150deg, #cfe0e4 0%, #9dbdc3 48%, #d6e4e6 100%)'
  },
  {
    id: 'forest',
    name: '雾中森林',
    css: 'linear-gradient(160deg, #cddcd4 0%, #a9c4b8 50%, #e2e9e2 100%)'
  },
  {
    id: 'dusk',
    name: '暮雾玫瑰',
    css: 'linear-gradient(150deg, #e3d8d6 0%, #cdb6ba 48%, #ece2e0 100%)'
  }
];

// 解析 state.background 为实际背景样式字符串；返回 '' 表示默认雾白。
export function resolveBackground(background) {
  if (typeof background !== 'string' || !background) return '';
  if (background === 'preset') return presetCss('mist');
  if (background.startsWith('preset:')) return presetCss(background.slice('preset:'.length));
  if (background === 'custom') return 'custom';
  return '';
}

function presetCss(id) {
  const preset = BG_PRESETS.find(item => item.id === id);
  return preset ? preset.css : '';
}
