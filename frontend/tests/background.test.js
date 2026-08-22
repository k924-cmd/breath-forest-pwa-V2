import test from 'node:test';
import assert from 'node:assert/strict';
import { BG_PRESETS, resolveBackground } from '../src/utils/background.js';

test('BG_PRESETS 提供 4 款冷雾渐变，id/name/css 齐全', () => {
  assert.equal(BG_PRESETS.length, 4);
  for (const preset of BG_PRESETS) {
    assert.ok(typeof preset.id === 'string' && preset.id);
    assert.ok(typeof preset.name === 'string' && preset.name);
    assert.match(preset.css, /^linear-gradient\(/);
  }
  const ids = new Set(BG_PRESETS.map(p => p.id));
  assert.equal(ids.size, 4, 'preset id 不得重复');
});

test('resolveBackground 默认与空值返回空串（默认雾白）', () => {
  assert.equal(resolveBackground(''), '');
  assert.equal(resolveBackground(undefined), '');
  assert.equal(resolveBackground(null), '');
  assert.equal(resolveBackground('default'), '');
});

test('resolveBackground 识别 preset 前缀与回退', () => {
  assert.match(resolveBackground('preset:mist'), /^linear-gradient\(/);
  assert.equal(resolveBackground('preset:mist'), BG_PRESETS[0].css);
  assert.match(resolveBackground('preset:forest'), /^linear-gradient\(/);
  assert.equal(resolveBackground('preset:forest'), BG_PRESETS[2].css);
});

test('resolveBackground 未知 preset 返回空串', () => {
  assert.equal(resolveBackground('preset:not-exist'), '');
});

test("resolveBackground 兼容旧版 'preset' 裸值（回退第一款）", () => {
  assert.equal(resolveBackground('preset'), BG_PRESETS[0].css);
});

test('resolveBackground custom 返回标记值，供上层决定读取自定义图', () => {
  assert.equal(resolveBackground('custom'), 'custom');
});
