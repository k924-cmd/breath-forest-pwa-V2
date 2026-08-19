#!/usr/bin/env node
// 语音唤醒评测脚本：检测率 / 漏报率 / 误触发率（FA）/ 唤醒时延。
//
// 用途：把「唤醒链路」的评测与 wer.js 的 ASR 评测对齐，形成"采集-标注-评测-回归"
// 的闭环。wer.js 度量转写文本的对齐错误；唤醒评测度量的是二元命中——唤醒词有没有
// 被检出、检出的有多快、有没有误报。
//
// 指标定义：
//   - 检测率（Detection Rate）   ：正样本（含唤醒词）中命中数 / 正样本总数
//   - 漏报率（Miss Rate）        ：1 - 检测率
//   - 误触发率（False Accept, FA）：负样本（干扰/不含唤醒词）中误报数 / 负样本总数；
//                                 也可按"每小时误触发"归一化（负样本时长累加）
//   - 唤醒时延（Latency）        ：命中时间戳 - 标注的唤醒词起始点 t0，输出均值/p50/p90
//
// 检测器接入：默认内置一个 demo 检测器（读 labels 模拟命中 + 固定时延），用于演示
// CLI 与输出格式。接入真实 Porcupine 时，把每次检测事件写成
//   {"id":"...","type":"positive"|"negative","detected":true|false,"latencyMs":123}
// 喂给本脚本的 same-line 格式即可（见下方 samples.json 结构）。
//
// 用法：
//   node tools/kws-eval.js                     # 跑内置 demo 样本
//   node tools/kws-eval.js ./samples.json      # 跑自己的样本

import { readFileSync } from "node:fs";

// ---- 样本 ----
const SAMPLE = {
  keyword: "小安",
  samples: [
    // 正样本：labels 标注唤醒词起止（秒）
    { id: "p1", type: "positive", audio: "demo", labels: [{ t0: 0.20, t1: 0.60 }], detected: true, latencyMs: 120 },
    { id: "p2", type: "positive", audio: "demo", labels: [{ t0: 1.10, t1: 1.50 }], detected: true, latencyMs: 180 },
    { id: "p3", type: "positive", audio: "demo", labels: [{ t0: 0.05, t1: 0.45 }], detected: false, latencyMs: null },
    { id: "p4", type: "positive", audio: "demo", labels: [{ t0: 2.00, t1: 2.40 }], detected: true, latencyMs: 240 },
    { id: "p5", type: "positive", audio: "demo", labels: [{ t0: 0.30, t1: 0.70 }], detected: true, latencyMs: 95 },
    // 负样本：不含唤醒词，durationSec 用于"每小时误触发"归一化
    { id: "n1", type: "negative", audio: "demo", durationSec: 60, detected: false },
    { id: "n2", type: "negative", audio: "demo", durationSec: 60, detected: true, latencyMs: 400 },
    { id: "n3", type: "negative", audio: "demo", durationSec: 120, detected: false },
  ],
};

// demo 检测器：无真实音频时模拟。positive 未显式给 detected → 用 labels 存在模拟命中；
// 真实场景应替换为从 Porcupine 日志拉取的检测结果。
function applyDemoDetector(data) {
  for (const s of data.samples ?? []) {
    if (s.type === "positive" && typeof s.detected !== "boolean") {
      s.detected = Array.isArray(s.labels) && s.labels.length > 0;
      s.latencyMs = s.detected ? 150 : null;
    }
    if (s.type === "negative" && typeof s.detected !== "boolean") {
      s.detected = false;
    }
  }
  return data;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function formatRate(rate) {
  return `${(rate * 100).toFixed(2)}%`;
}

function run(data) {
  const keyword = data?.keyword ?? "（未标注唤醒词）";
  const samples = Array.isArray(data?.samples) ? data.samples : [];
  if (samples.length === 0) {
    console.error("没有可评测样本：samples.json 需包含 samples 数组，如 {\"keyword\":\"小安\",\"samples\":[...]}");
    process.exitCode = 1;
    return;
  }

  const positive = samples.filter(s => s.type === "positive");
  const negative = samples.filter(s => s.type === "negative");
  const hits = positive.filter(s => s.detected === true);
  const fas = negative.filter(s => s.detected === true);
  const latencies = hits.map(s => s.latencyMs).filter(v => typeof v === "number" && v >= 0).sort((a, b) => a - b);

  const detectionRate = positive.length === 0 ? 1 : hits.length / positive.length;
  const missRate = 1 - detectionRate;
  const faRate = negative.length === 0 ? 0 : fas.length / negative.length;
  const totalNegativeSec = negative.reduce((acc, s) => acc + (Number(s.durationSec) || 0), 0);
  const faPerHour = totalNegativeSec > 0 ? (fas.length * 3600) / totalNegativeSec : null;
  const latencyAvg = latencies.length === 0 ? null : latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const latencyP50 = latencies.length === 0 ? null : percentile(latencies, 0.5);
  const latencyP90 = latencies.length === 0 ? null : percentile(latencies, 0.9);

  console.log(`\n=== 唤醒评测（唤醒词：${keyword}）===`);
  console.log(`样本：正 ${positive.length} 条 / 负 ${negative.length} 条`);
  console.log(`检测率: ${formatRate(detectionRate)}  漏报率: ${formatRate(missRate)}`);
  console.log(`误触发率（FA）: ${formatRate(faRate)}${faPerHour != null ? `  ≈ ${faPerHour.toFixed(2)} 次/小时` : "（负样本未标时长，无法按小时归一化）"}`);
  if (latencyAvg != null) {
    console.log(`唤醒时延（ms）: 均值 ${latencyAvg.toFixed(0)}  p50 ${latencyP50.toFixed(0)}  p90 ${latencyP90.toFixed(0)}`);
  } else {
    console.log("唤醒时延: 无命中样本");
  }

  console.log("\n--- 逐样本明细 ---");
  samples.forEach(s => {
    const mark = s.type === "positive" ? (s.detected ? "命中" : "漏报") : (s.detected ? "误触发" : "正常");
    const when = s.detected && s.latencyMs != null ? ` 时延 ${s.latencyMs}ms` : "";
    console.log(`  [${s.id}] ${s.type === "positive" ? "正" : "负"}样本  ${mark}${when}`);
  });

  // Bad Case：漏报的正样本与误触发的负样本按时延/严重度降序，对齐 wer.js 的降序找 Bad Case 习惯。
  const misses = positive.filter(s => s.detected !== true);
  const badFas = fas.slice();
  console.log("\n--- Bad Case（漏报 + 误触发）---");
  if (misses.length === 0 && badFas.length === 0) {
    console.log("  无 Bad Case：全部样本表现正常。");
  }
  misses.forEach(s => console.log(`  [${s.id}] 漏报  正样本未被唤醒，唤醒词应在 ${s.labels?.[0]?.t0 ?? "?"}s 处`));
  badFas
    .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))
    .forEach(s => console.log(`  [${s.id}] 误触发  负样本被误唤醒${s.latencyMs != null ? `（时延 ${s.latencyMs}ms）` : ""}`));
  console.log("");
}

// CLI 入口
function main() {
  const [file] = process.argv.slice(2);
  let data = SAMPLE;
  if (file) {
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`读取样本失败: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  if (data?.mode === "real") {
    runRealModel(data).then(result => run(result)).catch(err => {
      console.error(`真实模型评测失败: ${err.message}`);
      process.exitCode = 1;
    });
    return;
  }
  run(applyDemoDetector(data));
}

// 真实模型评测：样本 audio 为本地 wav 路径，逐个调 KWS 适配器（真实 Python 服务或
// 本地模拟）得检测结果，再喂给 run() 出指标。需 .env 配置 KWS_SERVICE_URL（真实服务）。
async function runRealModel(data) {
  const { readFileSync } = await import("node:fs");
  const { KwsHttpAdapter, KwsFallbackAdapter } = await import("../src/adapters/kws.js");
  const { loadDotEnvIfPresent } = await import("../src/config/env.js");
  loadDotEnvIfPresent(new URL("../.env", import.meta.url));
  const adapter = process.env.KWS_SERVICE_URL
    ? new KwsHttpAdapter({ enabled: true })
    : new KwsFallbackAdapter();
  if (!adapter.available) throw new Error("KWS 适配器不可用");
  const samples = [];
  for (const s of data.samples ?? []) {
    const audioPath = typeof s.audio === "string" && !s.audio.startsWith("http") ? s.audio : null;
    if (!audioPath) {
      samples.push({ ...s });
      continue;
    }
    const bytes = new Uint8Array(readFileSync(audioPath));
    const result = await adapter.check(bytes);
    samples.push({
      ...s,
      detected: result?.detected === true,
      latencyMs: result?.latencyMs ?? null,
    });
  }
  return { ...data, samples };
}

if (process.argv[1] && process.argv[1].endsWith("kws-eval.js")) {
  main();
}

// 测试用导出
export { run as kwsEvalRun, applyDemoDetector, percentile };
