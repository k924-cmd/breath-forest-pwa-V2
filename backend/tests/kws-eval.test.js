import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDemoDetector, percentile } from "../tools/kws-eval.js";

const SAMPLE = {
  keyword: "小安",
  samples: [
    { id: "p1", type: "positive", labels: [{ t0: 0.2, t1: 0.6 }], detected: true, latencyMs: 120 },
    { id: "p2", type: "positive", labels: [{ t0: 1.1, t1: 1.5 }], detected: false },
    { id: "n1", type: "negative", durationSec: 60, detected: true, latencyMs: 400 },
    { id: "n2", type: "negative", durationSec: 120, detected: false },
  ],
};

test("kws-eval: demo 检测器补齐未显式标注的 detected 字段", () => {
  const data = applyDemoDetector(JSON.parse(JSON.stringify(SAMPLE)));
  const byId = Object.fromEntries(data.samples.map(s => [s.id, s]));
  // 正样本未显式给 detected → 由 labels 推断为命中（p2 显式 false 保持 false）
  assert.equal(byId.p1.detected, true);
  assert.equal(byId.p2.detected, false);
});

test("kws-eval: 显式 detected 优先于 demo 推断", () => {
  const raw = {
    samples: [
      { id: "a", type: "positive", labels: [{ t0: 0 }], detected: false },
      { id: "b", type: "negative", detected: true },
    ],
  };
  const data = applyDemoDetector(JSON.parse(JSON.stringify(raw)));
  assert.equal(data.samples[0].detected, false);
  assert.equal(data.samples[1].detected, true);
});

test("kws-eval: 百分位计算正确", () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.9), 40);
  assert.equal(percentile([], 0.5), 0);
});
