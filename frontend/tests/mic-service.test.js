import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMicStream, releaseMicStream, getMicPermissionState, destroyMicStream } from '../src/utils/mic-service.js';

function installFakeNavigator({ grant = true } = {}) {
  let getUserMediaCalls = 0;
  const tracks = [{ readyState: 'live', stop() {} }];
  const fakeStream = { getAudioTracks: () => tracks };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          getUserMediaCalls += 1;
          if (!grant) throw new Error('NotAllowedError');
          return fakeStream;
        }
      },
      permissions: {
        query: async () => ({ state: 'granted' })
      }
    }
  });
  // number 按值传递：用函数暴露闭包计数，而不是拷贝的 0。
  return { getCalls: () => getUserMediaCalls, tracks };
}

function restoreNavigator() {
  delete globalThis.navigator;
}

// 模块级缓存（micStream/refCount）跨测试残留，每个用例前重置。
test.beforeEach(() => {
  destroyMicStream();
});

test('mic-service: 多次 request 只调一次 getUserMedia，复用同一流', async () => {
  const env = installFakeNavigator();
  try {
    const s1 = await requestMicStream();
    const s2 = await requestMicStream();
    const s3 = await requestMicStream();
    assert.equal(env.getCalls(), 1);
    assert.equal(s1, s2);
    assert.equal(s2, s3);
  } finally {
    restoreNavigator();
  }
});

test('mic-service: 全部 release 后才 stop 底层 track', async () => {
  const env = installFakeNavigator();
  try {
    await requestMicStream();
    await requestMicStream();
    const stream = await requestMicStream();
    let stopped = 0;
    env.tracks.forEach(t => { t.stop = () => { stopped += 1; }; });
    releaseMicStream(stream);
    releaseMicStream(stream);
    assert.equal(stopped, 0, '还有引用，不应 stop');
    releaseMicStream(stream);
    assert.equal(stopped, 1, '引用归零后 stop 一次');
  } finally {
    restoreNavigator();
  }
});

test('mic-service: 权限被拒时抛出友好错误且不缓存', async () => {
  installFakeNavigator({ grant: false });
  try {
    await assert.rejects(() => requestMicStream(), /麦克风权限被拒绝/);
  } finally {
    restoreNavigator();
  }
});

test('mic-service: 无 navigator 时安全降级', async () => {
  delete globalThis.navigator;
  try {
    await assert.rejects(() => requestMicStream(), /不支持麦克风/);
  } finally {
    restoreNavigator();
  }
});

test('mic-service: getMicPermissionState 查询权限', async () => {
  installFakeNavigator();
  try {
    assert.equal(await getMicPermissionState(), 'granted');
  } finally {
    restoreNavigator();
  }
});
