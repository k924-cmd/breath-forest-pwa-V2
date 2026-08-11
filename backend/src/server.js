import { fileURLToPath } from "node:url";
import { createHttpAssistantServer, DEFAULT_ALLOWED_ORIGINS, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } from "./api/http-server.js";
import { createLocalAssistant, DeepSeekModelAdapter, SqliteStateRepository, TavilySearchAdapter, DashScopeAsrAdapter, MiMoTtsAdapter } from "./index.js";
import { loadDotEnvIfPresent } from "./config/env.js";

loadDotEnvIfPresent(fileURLToPath(new URL("../.env", import.meta.url)));
const host = process.env.HOST || DEFAULT_HTTP_HOST;
const configuredPort = Number(process.env.PORT ?? DEFAULT_HTTP_PORT);
const port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535 ? configuredPort : DEFAULT_HTTP_PORT;
const allowedOrigins = process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS;
const allowOriginWildcard = ["1", "true", "yes", "on"].includes(String(process.env.ALLOW_ORIGINS_WILDCARD ?? "").toLowerCase());
const apiKey = process.env.API_KEY ?? "";
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH ?? "";
const rateLimitEnabled = ["1", "true", "yes", "on"].includes(String(process.env.RATE_LIMIT_ENABLED ?? "").toLowerCase());
const rateLimitMax = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 10);

function resolveModel() {
  const enabled = ["1", "true", "yes", "on"].includes(String(process.env.DEEPSEEK_ENABLED ?? "").toLowerCase());
  if (!enabled || !process.env.DEEPSEEK_API_KEY) return null;
  return new DeepSeekModelAdapter();
}

function resolveRealtime() {
  const enabled = ["1", "true", "yes", "on"].includes(String(process.env.TAVILY_ENABLED ?? "").toLowerCase());
  if (!enabled || !process.env.TAVILY_API_KEY) return null;
  return new TavilySearchAdapter();
}

function resolveAsr() {
  const enabled = ["1", "true", "yes", "on"].includes(String(process.env.DASHSCOPE_ENABLED ?? "").toLowerCase());
  if (!enabled || !process.env.DASHSCOPE_API_KEY) return null;
  return new DashScopeAsrAdapter();
}

function resolveTts() {
  const enabled = ["1", "true", "yes", "on"].includes(String(process.env.MIMO_ENABLED ?? "").toLowerCase());
  if (!enabled || !process.env.MIMO_API_KEY) return null;
  return new MiMoTtsAdapter();
}

function resolveRepository() {
  const enabled = ["1", "true", "yes", "on"].includes(String(process.env.SQLITE_ENABLED ?? "1").toLowerCase());
  if (!enabled) return null;
  const path = process.env.SQLITE_DB_PATH || fileURLToPath(new URL("../data/forest.db", import.meta.url));
  return new SqliteStateRepository({ path });
}

const model = resolveModel();
const realtime = resolveRealtime();
const asr = resolveAsr();
const tts = resolveTts();
const repository = resolveRepository();
const assistant = createLocalAssistant({ ...(model ? { model } : {}), ...(realtime ? { realtime } : {}), ...(asr ? { asr } : {}), ...(tts ? { tts } : {}), ...(repository ? { repository } : {}) });
const service = createHttpAssistantServer({
  assistant, host, port, allowedOrigins, allowOriginWildcard,
  apiKey,
  ...(adminPasswordHash ? { adminPasswordHash } : {}),
  rateLimitEnabled,
  ...(rateLimitMax > 0 ? { rateLimitMax } : {}),
});
const address = await service.start();

console.log(`呼吸森林本地 HTTP 服务监听 ${address.url}${model ? `；真实模型适配器已启用（${model.model}，密钥不显示）` : ""}${realtime ? `；实时搜索适配器已启用（${realtime.referenceId}，密钥不显示）` : ""}${asr ? `；ASR 语音识别适配器已启用（${asr.model}，密钥不显示）` : ""}${tts ? `；MiMo TTS 唱歌彩蛋已启用（${tts.model}，密钥不显示）` : ""}${repository ? `；SQLite 持久化已启用（${repository.file}）` : ""}`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await service.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
