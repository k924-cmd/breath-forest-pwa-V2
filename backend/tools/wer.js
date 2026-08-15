#!/usr/bin/env node
// ASR 转写评测脚本：CER（字符错误率）与 WER（词错误率）计算。
//
// 用途：语音模型评测体系的"指标树"最小闭环——给定一批人工期望文本（gold）
// 与 ASR 转写结果（hyp），输出错误率 + 错/替/删/插分类统计，供 Bad Case 分析使用。
//
// 三种粒度：
//   - char : 字符级 CER（中文按单字切分，汉字转写常用）
//   - word : 词级 WER（按空白切分，英文/带空格文本常用）
//   - asr  : 音字混合（中文单字 + 英文整词），中文语音评测的常见口径
//
// 用法：
//   node tools/wer.js                     # 跑内置 5 条示例样本，全链路演示
//   node tools/wer.js ./samples.json      # 跑自己的样本
//   node tools/wer.js ./samples.json word # 指定粒度（char|word|asr，默认 asr）
//
// samples.json 结构：{"granularity":"asr","samples":[{"id":"1","gold":"...","hyp":"..."}]}
//   granularity 省略则用命令行参数（默认 asr）。
//
// 中文对齐说明：CER 按 UTF-16 code unit 切分单字，标点/空白保留参与对齐；
// 若要去标点可在切分前先归一化（见 normalize 常量，默认为关闭）。

import { readFileSync } from "node:fs";

// ---- 归一化（默认全关，按需开启）----
const NORMALIZE = {
  lowercase: false, // 英文转小写
  collapseSpaces: false, // 连续空白折叠为单空格
  stripPunct: false, // 去标点（保留中文/英文/数字）
};

function normalizeText(text) {
  let t = String(text ?? "");
  if (NORMALIZE.collapseSpaces) t = t.replace(/\s+/g, " ");
  if (NORMALIZE.lowercase) t = t.toLowerCase();
  if (NORMALIZE.stripPunct) t = t.replace(/[^\p{Script=Han}\p{L}\p{N}\s]/gu, "");
  return t;
}

// ---- 切分 ----
// 音字混合：汉字逐字 + 英文/数字整词。
export function segmentAsr(text) {
  const out = [];
  const re = /[㐀-䶿一-鿿]|[A-Za-z0-9']+|./g;
  for (const m of text.match(re) ?? []) {
    if (/[㐀-䶿一-鿿]/.test(m)) {
      for (const ch of m) out.push(ch);
    } else {
      out.push(m);
    }
  }
  return out;
}

// ---- 最小编辑距离（Levenshtein）DP，回溯出 正确/替换/删除/插入 计数 ----
export function editOps(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  // 回溯
  let i = n, j = m;
  const counts = { correct: 0, substitution: 0, deletion: 0, insertion: 0 };
  const aligned = [];
  while (i > 0 || j > 0) {
    const diag = i > 0 && j > 0 ? d[i - 1][j - 1] : Infinity;
    const del = i > 0 ? d[i - 1][j] : Infinity;
    const ins = j > 0 ? d[i][j - 1] : Infinity;
    const base = Math.min(diag, del, ins);
    if (diag === base) {
      const refCh = ref[i - 1];
      const hypCh = hyp[j - 1];
      if (refCh === hypCh) counts.correct += 1;
      else counts.substitution += 1;
      aligned.push(refCh === hypCh ? { op: "=", ref: refCh, hyp: hypCh } : { op: "S", ref: refCh, hyp: hypCh });
      i -= 1; j -= 1;
    } else if (del === base) {
      counts.deletion += 1;
      aligned.push({ op: "D", ref: ref[i - 1], hyp: null });
      i -= 1;
    } else {
      counts.insertion += 1;
      aligned.push({ op: "I", ref: null, hyp: hyp[j - 1] });
      j -= 1;
    }
  }
  aligned.reverse();
  return { counts, aligned };
}

export function werMetrics(counts) {
  const total = counts.correct + counts.substitution + counts.deletion;
  const errors = counts.substitution + counts.deletion + counts.insertion;
  return {
    total,
    errors,
    substitutions: counts.substitution,
    deletions: counts.deletion,
    insertions: counts.insertion,
    errorRate: total === 0 ? 0 : errors / total,
    accuracy: total === 0 ? 1 : counts.correct / total,
  };
}

function segmentByGranularity(granularity, text) {
  if (granularity === "char") return [...text];
  if (granularity === "word") return text.split(/\s+/).filter(Boolean);
  return segmentAsr(text); // asr（默认）
}

function formatRate(rate) {
  return `${(rate * 100).toFixed(2)}%`;
}

// 中文展示时插入空白便于阅读
function displayRefs(aligned) {
  return aligned.map(a => (a.op === "=" ? a.ref : `[${a.ref}]`)).join(" ");
}
function displayHyps(aligned) {
  return aligned.map(a => (a.op === "=" ? a.hyp : a.hyp === null ? "___" : `[${a.hyp}]`)).join(" ");
}

const SAMPLE = {
  granularity: "asr",
  samples: [
    { id: "demo-1", gold: "打开客厅的空气净化器", hyp: "打开客厅的空气净化器" },
    { id: "demo-2", gold: "帮我设置新风定时到早上七点", hyp: "帮我设置新风定时到早上七点" },
    { id: "demo-3", gold: "把净化器调到睡眠模式", hyp: "把净化器调倒睡眠模式" },
    { id: "demo-4", gold: "客厅湿度有点高怎么办", hyp: "客厅湿度有点高" },
    { id: "demo-5", gold: "PM2.5 超标了，建议开窗吗", hyp: "PM2.5 超标了建议开窗吗" },
  ],
};

function run(data, granularity) {
  const g = granularity ?? data?.granularity ?? "asr";
  const samples = Array.isArray(data?.samples) ? data.samples : [];
  if (samples.length === 0) {
    console.error("没有可评测样本：samples.json 需包含 samples 数组，如 {\"samples\":[{\"id\":\"1\",\"gold\":\"...\",\"hyp\":\"...\"}]}");
    process.exitCode = 1;
    return;
  }

  const rows = samples.map(s => {
    const ref = segmentByGranularity(g, normalizeText(s.gold));
    const hyp = segmentByGranularity(g, normalizeText(s.hyp));
    const { counts, aligned } = editOps(ref, hyp);
    return { id: s.id ?? "?", gold: s.gold, hyp: s.hyp, ref, hypSeg: hyp, counts, aligned, metrics: werMetrics(counts) };
  });

  const agg = rows.reduce(
    (acc, r) => {
      acc.correct += r.counts.correct;
      acc.substitution += r.counts.substitution;
      acc.deletion += r.counts.deletion;
      acc.insertion += r.counts.insertion;
      return acc;
    },
    { correct: 0, substitution: 0, deletion: 0, insertion: 0 }
  );
  const aggMetrics = werMetrics(agg);

  console.log(`\n=== ASR 评测（粒度：${g === "char" ? "字符 CER" : g === "word" ? "词 WER" : "音字混合 WER"}，样本数 ${rows.length}）===`);
  console.log(`错误率（CER/WER）: ${formatRate(aggMetrics.errorRate)}  准确率: ${formatRate(aggMetrics.accuracy)}`);
  console.log(`对齐单元总数: ${aggMetrics.total}  错误: ${aggMetrics.errors}`);
  console.log(`  替换(S): ${agg.substitution}  删除(D): ${agg.deletion}  插入(I): ${agg.insertion}`);
  console.log("\n--- 逐句明细 ---");
  rows.forEach((r, idx) => {
    const m = r.metrics;
    console.log(`\n[${r.id}] 错误率 ${formatRate(m.errorRate)}（S${r.counts.substitution} D${r.counts.deletion} I${r.counts.insertion}）`);
    console.log(`  期望: ${r.gold}`);
    console.log(`  实际: ${r.hyp}`);
    console.log(`  对齐: ${displayRefs(r.aligned)}`);
    console.log(`        ${displayHyps(r.aligned)}`);
  });

  console.log("\n--- 聚合（按错误率降序，便于找 Bad Case）---");
  [...rows]
    .sort((a, b) => b.metrics.errorRate - a.metrics.errorRate)
    .forEach(r => console.log(`  [${r.id}] ${formatRate(r.metrics.errorRate)}  ${r.gold}  ->  ${r.hyp}`));
  console.log("");
}

// CLI 入口
function main() {
  const [file, granularityArg] = process.argv.slice(2);
  const valid = new Set(["char", "word", "asr"]);
  if (granularityArg && !valid.has(granularityArg)) {
    console.error(`未知粒度 "${granularityArg}"，可选：char|word|asr`);
    process.exitCode = 1;
    return;
  }
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
  run(data, granularityArg);
}

if (process.argv[1] && process.argv[1].endsWith("wer.js")) {
  main();
}
