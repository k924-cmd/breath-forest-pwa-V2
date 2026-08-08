// Singing easter-egg orchestration for the breath forest assistant.
//
// Flow (3 external calls, per the product decision):
//   1. ASR text (already produced by qwen3-asr-flash upstream)
//   2. DeepSeek in ONE call: judge whether the user is singing + recognize the
//      song + continue the next two lyric lines.
//   3. MiMo TTS sings those two lines.
//
// The final assistant text reply is a fixed template: two lyric lines +
// a hand-back line that anchors the conversation to the air-manager persona.
// The module is pure orchestration and holds no keys; adapters are injected.

export const EASTER_EGG_SYSTEM_PROMPT = [
  "你是“呼吸森林”空气小助手的唱歌彩蛋裁判。用户可能会唱歌、哼唱或念一段歌词给你听。",
  "请判断用户是否真的在唱歌或念歌词（含糊的语音转写、明显的旋律哼唱、歌词片段都算）。",
  "如果确实是在唱歌：识别最可能的歌名，并接续歌词给出接下来的两句（贴合原曲风格即可，不必逐字准确）。",
  "如果用户只是普通说话（口齿不清、闲聊、问问题），则不算唱歌。",
  "只输出严格 JSON（不要输出任何其他文字）：",
  '{"isSinging":true|false,"songName":"歌名或空字符串","continuation":"接续的两句歌词，不含换行标点；不是唱歌时为空字符串"}',
].join("\n");

export const EASTER_REPLY_TEMPLATE = (continuation) =>
  `🎵 Luna 跟着哼了两句：${continuation}\n哈哈……人家唱歌跑调嘛～不过我可是你的空气小助手 Luna，净化器、新风、窗户、抽油烟机都能帮你照顾好。唱歌不擅长，管家可是专业的！有需要随时喊我～`;

export function parseEasterDecision(content) {
  try {
    const cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const isSinging = parsed?.isSinging === true;
    const songName = typeof parsed?.songName === "string" ? parsed.songName.trim() : "";
    const continuation = typeof parsed?.continuation === "string" ? parsed.continuation.trim() : "";
    if (!isSinging || !continuation) return null;
    return { isSinging, songName, continuation };
  } catch {
    return null;
  }
}

export class SingingEasterEgg {
  constructor(dependencies = {}) {
    this.model = dependencies.model ?? null;
    this.tts = dependencies.tts ?? null;
  }

  get available() {
    return Boolean(this.model?.generative === true && this.tts?.available === true);
  }

  // Returns null when the user is not singing or when any adapter fails, so
  // the caller keeps its normal fallback (the caller decides the fallback
  // message). Never throws.
  async run(userText) {
    if (!this.available) return null;
    const text = typeof userText === "string" ? userText.trim() : "";
    if (!text) return null;
    let decision;
    try {
      const reply = await this.model.respond({ kind: "chat", message: text, easterEgg: true });
      decision = parseEasterDecision(reply);
    } catch {
      return null;
    }
    if (!decision) return null;
    let tts;
    try {
      tts = await this.tts.synthesize(decision.continuation, { sing: true });
    } catch {
      return null;
    }
    if (!tts) return null;
    return {
      songName: decision.songName,
      continuation: decision.continuation,
      audio: tts.audio,
      format: tts.format,
      voice: tts.voice,
      replyText: EASTER_REPLY_TEMPLATE(decision.continuation),
    };
  }
}
