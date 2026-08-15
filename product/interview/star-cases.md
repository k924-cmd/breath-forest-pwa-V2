# STAR 复盘案例 —— Qwen3-ASR-Flash 选型 + MiMo TTS（播报 + 唱歌彩蛋）

> 面试用途：学习计划第 12 天。三个真实一手案例，量化 + 决策链路完整，可当 STAR 讲，也可拆成「工程决策题」「降级设计题」「跨角色协调题」的子答案。
>
> 案例代码：`backend/src/adapters/dashscope-asr.js`、`backend/src/adapters/mimo-tts.js`、`backend/src/conversation/mimo-easter.js`、`backend/src/conversation/assistant-service.js`（synthesizeSpeech）、`frontend/src/utils/audio.js`、`frontend/src/services/easter-service.js`、`frontend/src/services/tts-service.js`。
> 配套测试：`backend/tests/dashscope-asr.test.js`、`mimo-tts.test.js`、`mimo-easter.test.js`、`http-easter.test.js`（后端共 179 个测试全绿）。
> 当前版本：v20260808-11。

---

## 案例一：给语音助手接上 ASR——选型对比中做对的工程决策

### Situation（背景）
呼吸森林是空气管理语音助手，PWA + 无后端依赖的原生 Node 服务。产品要求支持「长按说话 → 转中文文本 → 对话/发指令」。目标：移动端为主、低延迟、能上真机验证。

### Task（任务）
选一个 ASR 方案并接入，满足：同步返回、中文识别准、移动端录音格式兼容、失败不能拖垮主对话（要能降级）。

### Action（行动）
1. **候选对比**：paraformer-v2 vs qwen3-asr-flash。
   - paraformer-v2：只有异步任务式接口（需音频公网 URL + 轮询）或 WebSocket 实时流式，不满足"同步、简单"的诉求。
   - qwen3-asr-flash：走 OpenAI-compatible `POST /compatible-mode/v1/chat/completions`，音频内联 base64 data URI 随请求发出，同步返回文本——接入成本最低。
   - → 选 qwen3-asr-flash（代码 `dashscope-asr.js:11-13` 的默认端点/模型即此决策）。
2. **链路设计**：前端 MediaRecorder 录音 → 格式回退（webm/ogg/mp4）→ 后端 8MB raw-body 限制 → 适配器内联 base64 → ASR → 回填 textarea（可编辑不自动发）。
3. **降级与安全**：适配器任何失败（不可用/超时/非 2xx/空转写/异常）统一 `return null`，调用方回落既有拒绝路径；API Key 从不进日志与错误信息。
4. **一手踩坑验证**：纯音调（440Hz beep）被 ASR 判空 → 后端 503；16kHz 单声道 WAV 最稳；移动端需手势解锁 AudioContext 才能出声。

### Result（结果）
- 语音输入全链路真机跑通，返回正确中文。
- 后端 171 测试全绿（含 `dashscope-asr.test.js` 覆盖成功/不可用/超时/非法 JSON/空转写全路径）。
- 换路决策（paraformer→qwen3）在接入前做掉，未产生返工成本。

---

## 案例二：MiMo 唱歌彩蛋——把 ASR + Speech LLM + TTS 串成语音 Agent

### Situation（背景）
产品希望有"人性化惊喜"：用户唱歌/哼歌时，AI 管家能接两句并唱出来。难点：这不是三个接口各自调用，而是要**判断"用户是不是在唱歌"**，再联动 TTS 唱歌——是一个多模型编排问题。

### Task（任务）
设计一个「唱歌彩蛋」：ASR 转写 → 判断+识别歌名+接续 → TTS 唱出来。同时必须保证：普通对话不受影响、任何一步失败都优雅降级、移动端能真正出声。

### Action（行动）
1. **一次调用干三件事**（`mimo-easter.js:22`）：DeepSeek 一次响应完成「是否唱歌 + 歌名 + 接续两句」，强制输出严格 JSON（`isSinging/songName/continuation`），把 3 次 LLM 调用压成 1 次，省往返。
2. **容错解析**（`parseEasterDecision`，`mimo-easter.js:25`）：剥 code block、截 `{…}`，JSON 不规整也能兜住。
3. **TTS 唱歌模式**：文本前置 `(唱歌)` 标签 + 显式演唱指令（"轻柔平稳缓慢"），茉莉音色（`mimo-tts.js:64-84`）。
4. **降级安全网**：彩蛋三层（ASR→LLM→TTS）任一层失败 `return null`，回落普通对话——用户永远不被卡死（`mimo-easter.js:55`）。
5. **移动端音频**：发送手势时解锁 AudioContext，用 Web Audio 播放替代 `<audio>.play()`，绕过浏览器自动播放限制。
6. **测试先行**：新增 `mimo-tts.test.js`（请求结构/唱歌标签/失败路径）、`mimo-easter.test.js`（决策解析/降级）。

### Result（结果）
- 真机全链路验证：识别歌名 + 接续歌词 + 唱出有效 WAV（茉莉音色）。
- 普通对话零回归：彩蛋判断失败即回普通回复，用户感知为"这次没唱歌"而非"AI 坏了"。
- 后端测试从 150+ → 171，覆盖新增彩蛋链路的成功与全部失败路径。

---

## 案例三：补齐语音播报——把单向输入升级成双向语音闭环

### Situation（背景）
彩蛋做好后，交互仍是"不对称"的：用户对着 app 说话（ASR 已通），但 AI 只在屏幕回文字。对一个空气管家，典型场景是**腾不开手**（做饭、进卧室），需要回复"说"出来。

### Task（任务）
给正常对话回复加上 TTS 播报，让语音闭环闭合。约束：不打断现有彩蛋链路、播报可关、失败不能拖垮对话、移动端能出声。

### Action（行动）
1. **复用而非新建**：不另起一套 TTS 基础设施，直接给 `AssistantService` 加 `synthesizeSpeech()`（`assistant-service.js`），复用既有 MiMo 适配器——正常合成与唱歌只差一个 `sing` 参数。
2. **新增端点**：`POST /v1/tts/speak`（`{text}` → `{available,audio,format,voice}`），请求体校验 + 加入限流路径（`http-server.js`）。
3. **前端接入**：新增 `tts-service.js`；`sendMessage` 拿到正常回复后 `speakReply()` 调 `/v1/tts/speak` 并 `playBase64Audio` 播放——播放基础设施与彩蛋共享。
4. **用户可控**：「我的」页加「语音播报」开关（`settings.speak` 默认开启），避免公共场合外放尴尬。
5. **静默降级**：合成失败/超时/空音频一律 `return null`，只丢声音不丢文字回复，绝不阻塞对话。
6. **测试 + 版本**：后端加 speak 三测（正常/503/校验）；前端版本 -10→-11、SW CACHE v37，符合运维规范。

### Result（结果）
- 完整双向语音闭环：**说话（ASR）→ 对话 → 回复说出来（TTS）**。
- 浏览器实测发消息 fetch 链路：`easter-egg` → `conversations/messages` → `tts/speak`，新端点被正确触发；开关切换持久化正常。
- 后端测试 171 → 179 全绿、前端 53/53 全绿；彩蛋零回归（播报走独立分支）。
- 架构收益：唱歌彩蛋从"独立功能"变成"TTS 层的人格化分支"，与播报共享同一套降级/播放/安全底座。

---

## 可复用的话术（背下来直接用）

### "为什么选 qwen3-asr-flash？"
> "我对比过 paraformer-v2 和 qwen3-asr-flash：paraformer 只有异步任务式或 WebSocket 流式接口，不满足我同步、简单的接入诉求；qwen3 走 OpenAI-compatible、音频内联，接入成本最低，中文转写实测稳定。选型的关键不是'谁最好'，而是'谁最匹配当前链路约束'。"

### "唱歌彩蛋最难的环节？"
> "最难的不是 TTS，而是'判断用户是不是在唱歌'——ASR 只给文本，文本特征会丢。我用一次 LLM 调用做意图判断，并用强制 JSON 输出约束结果；同时配了容错解析，即使 JSON 不规整也能兜住。这让我体会到 Speech LLM 的核心：把感知与理解串起来，而不是各管一段。"

### "如何保证语音链路稳定？"
> "每层都做降级：ASR 失败回判空提示，意图判断失败回普通对话，TTS 失败回文本回复。用户永远有兜底。再配合接口超时、限流、Key 不入库，整个链路在弱网下也不会拖垮主对话。"

### "为什么唱歌彩蛋之外还做语音播报？"
> "彩蛋是低频高光，播报是日常刚需。语音助手的核心场景是用户腾不开手——做饭、进卧室，需要回复说出来而不是看屏幕。所以我给正常对话回复加了 TTS 播报，让语音闭环闭合；彩蛋则复用同一套 TTS/播放/降级底座，变成播报的一个特殊模式。同一个基础设施，两条产品价值。"

---

## 量化小结（面试可抛的数字）

| 指标 | 数值 |
|---|---|
| 后端测试 | 179 全绿（含 ASR/TTS/彩蛋/播报全路径） |
| 前端测试 | 53 全绿 |
| 语音链路 | 双向闭环：ASR 输入 + 播报输出 + 唱歌分支 |
| 录音上限 | 15s，格式回退 webm/ogg/mp4 |
| 音频上限 | 后端 8MB，ASR 超时 30s 可配 |
| 降级路径 | 4 条（ASR/意图判断/播报/彩蛋各自回落）|
| 用户控制 | 语音播报开关（`settings.speak`） |
| WER 工具 | `tools/wer.js`：CER/WER + 错/替/删/插 + 3 种粒度 |
