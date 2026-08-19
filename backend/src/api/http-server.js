import { createServer } from "node:http";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createLocalAssistant } from "../index.js";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8787;
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze(["http://localhost:4173", "http://127.0.0.1:4173", "http://localhost:4174", "http://127.0.0.1:4174"]);
export const DEFAULT_ALLOW_ORIGINS_WILDCARD = false;
export const DEFAULT_API_KEY = "";
export const DEFAULT_ADMIN_PASSWORD_HASH = "";
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_ENABLED = false;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
// 语音路由（ASR 音频上传 / TTS 合成）在慢网络下可能超过全局请求超时，单独放宽期限。
export const DEFAULT_VOICE_TIMEOUT_MS = 35_000;

class HttpTransportError extends Error {
  constructor(status, code, message, retryable = false, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.headers = headers;
  }
}

export function createHttpAssistantServer(options = {}) {
  const assistant = options.assistant ?? createLocalAssistant();
  const host = options.host ?? DEFAULT_HTTP_HOST;
  const port = options.port ?? DEFAULT_HTTP_PORT;
  const allowedOrigins = normalizeOrigins(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const allowOriginWildcard = options.allowOriginWildcard ?? DEFAULT_ALLOW_ORIGINS_WILDCARD;
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const adminPasswordHash = options.adminPasswordHash ?? DEFAULT_ADMIN_PASSWORD_HASH;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const rateLimitEnabled = options.rateLimitEnabled ?? DEFAULT_RATE_LIMIT_ENABLED;
  const rateLimitMax = options.rateLimitMax ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const actorId = options.actorId ?? "local-http-actor";
  const scopeId = options.scopeId ?? "local-http-scope";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const voiceTimeoutMs = options.voiceTimeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
  const sessions = new Map(); // token -> expiresAt（内存级会话，进程重启即失效）
  const rateBuckets = rateLimitEnabled ? new Map() : null; // ip -> number[]（时间戳）
  let requestSequence = 0;
  let listening = false;
  const rateSweeper = rateLimitEnabled ? setInterval(() => sweepRateBuckets(rateBuckets), 60_000) : null;
  rateSweeper?.unref?.();

  const server = createServer(async (request, response) => {
    const requestId = `http-${String(++requestSequence).padStart(6, "0")}`;
    const origin = request.headers.origin;
    const originAllowed = !origin || allowedOrigins.has(origin) || (allowOriginWildcard && isHttpsOrigin(origin));
    const corsHeaders = origin && originAllowed
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};
    let timedOut = false;
    let deadline;
    const startDeadline = (timeoutMs) => {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => {
        timedOut = true;
        if (!response.writableEnded) writeError(response, requestId, new HttpTransportError(503, "SERVICE_UNAVAILABLE", "请求处理超时。", true), corsHeaders);
      }, timeoutMs);
      deadline.unref?.();
    };
    startDeadline(requestTimeoutMs);

    try {
      if (origin && !originAllowed) throw new HttpTransportError(403, "POLICY_REJECTED", "请求来源不在允许列表中。");
      if (request.method === "OPTIONS") {
        validatePreflight(request);
        response.writeHead(204, {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, Authorization",
          "Access-Control-Max-Age": "600",
        });
        response.end();
        return;
      }
      if (apiKey && request.headers["x-api-key"] !== apiKey) throw new HttpTransportError(401, "UNAUTHORIZED", "请求缺少有效 API Key。");

      const pathname = parsePathname(request.url);
      const isAuthRoute = pathname === "/v1/auth/login" || pathname === "/v1/auth/logout";
      const isPublicSnapshot = pathname === "/v1/health" || pathname === "/v1/bootstrap" || pathname === "/v1/kws/check";
      if (!isAuthRoute && !isPublicSnapshot && adminPasswordHash) {
        const bearer = String(request.headers.authorization ?? "");
        const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
        if (!token || !hasActiveSession(sessions, token, Date.now())) throw new HttpTransportError(401, "UNAUTHORIZED", "请求缺少有效登录会话。");
      }
      if (rateLimitEnabled && isRateLimitedPath(pathname) && request.method === "POST") {
        const ip = clientIp(request);
        if (ip && isRateLimited(rateBuckets, ip, rateLimitMax)) {
          throw new HttpTransportError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试。", false, { "Retry-After": "60" });
        }
      }
      if (pathname === "/v1/auth/login") {
        requireMethod(request, "POST");
        requireJsonContentType(request);
        const body = await readJsonBody(request, maxBodyBytes);
        validateLoginBody(body);
        const authorized = verifyAdminLogin(adminPasswordHash, body.username, body.password);
        if (!authorized) throw new HttpTransportError(401, "INVALID_CREDENTIALS", "账号或密码不正确。");
        const token = randomBytes(32).toString("hex");
        sessions.set(token, Date.now() + sessionTtlMs);
        writeJson(response, 200, { token, expiresInMs: sessionTtlMs }, corsHeaders);
        return;
      }
      if (pathname === "/v1/auth/logout") {
        requireMethod(request, "POST");
        const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
        if (token) sessions.delete(token);
        writeJson(response, 200, { ok: true }, corsHeaders);
        return;
      }
      if (pathname === "/v1/health") {
        requireMethod(request, "GET");
        writeJson(response, 200, { status: "ok", contractVersion: "1.0.0", mode: "local_mock" }, corsHeaders);
        return;
      }
      if (pathname === "/v1/bootstrap") {
        requireMethod(request, "GET");
        const bootstrap = await assistant.getBootstrap(scopeId);
        if (!timedOut && !response.writableEnded) writeJson(response, 200, bootstrap, corsHeaders);
        return;
      }
      if (pathname === "/v1/weather") {
        requireMethod(request, "GET");
        const city = new URL(request.url, "http://localhost").searchParams.get("city") || "杭州";
        const result = await assistant.getWeather(city);
        if (!timedOut && !response.writableEnded) writeJson(response, 200, result, corsHeaders);
        return;
      }
      if (pathname === "/v1/asr") {
        requireMethod(request, "POST");
        startDeadline(voiceTimeoutMs);
        const mimeType = parseAudioContentType(request.headers["content-type"]);
        const audio = await readRawBody(request, maxAudioBytes);
        const result = await assistant.transcribeAudio(audio, { mimeType });
        if (result?.available === true && typeof result.text === "string" && result.text) {
          if (!timedOut && !response.writableEnded) writeJson(response, 200, { text: result.text }, corsHeaders);
          return;
        }
        throw new HttpTransportError(503, "SERVICE_UNAVAILABLE", "语音识别服务暂不可用，请稍后再试。", true);
      }
      if (pathname === "/v1/kws/check") {
        requireMethod(request, "POST");
        startDeadline(voiceTimeoutMs);
        const audio = await readRawBody(request, maxAudioBytes);
        const result = await assistant.checkWakeWord(audio);
        if (!timedOut && !response.writableEnded) {
          writeJson(response, 200, {
            detected: result.detected === true,
            keyword: result.keyword ?? "小云小云",
            score: result.score ?? null,
            latencyMs: result.latencyMs ?? null,
            source: result.source ?? null,
          }, corsHeaders);
        }
        return;
      }
      if (pathname === "/v1/tts/speak") {
        requireMethod(request, "POST");
        startDeadline(voiceTimeoutMs);
        requireJsonContentType(request);
        const body = await readJsonBody(request, maxBodyBytes);
        validateSpeakBody(body);
        const result = await assistant.synthesizeSpeech(body.text, { voice: body.voice });
        if (result?.available === true) {
          if (!timedOut && !response.writableEnded) {
            writeJson(response, 200, {
              available: true,
              audio: Buffer.from(result.audio).toString("base64"),
              format: result.format,
              voice: result.voice,
            }, corsHeaders);
          }
          return;
        }
        throw new HttpTransportError(503, "SERVICE_UNAVAILABLE", "语音合成服务暂不可用，请稍后再试。", true);
      }
      if (pathname === "/v1/tts/stream") {
        requireMethod(request, "POST");
        startDeadline(voiceTimeoutMs);
        requireJsonContentType(request);
        const body = await readJsonBody(request, maxBodyBytes);
        validateSpeakBody(body);
        // SSE 流式播报：逐句合成即推。绕过 writeJson，走独立写路径。
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          ...corsHeaders,
        });
        const hasStreaming = typeof assistant.synthesizeSpeechStreaming === "function";
        if (!hasStreaming) {
          response.end("event: error\ndata: {\"code\":\"SERVICE_UNAVAILABLE\",\"message\":\"流式语音合成不可用\"}\n\n");
          return;
        }
        let streamOk = false;
        try {
          const outcome = await assistant.synthesizeSpeechStreaming(body.text, {
            onChunk: (chunk) => {
              if (timedOut || response.writableEnded) return;
              streamOk = streamOk || !chunk.failed;
              response.write(`data: ${JSON.stringify(chunk)}\n\n`);
            },
          });
          if (outcome?.available === false && !streamOk) {
            if (!timedOut && !response.writableEnded) {
              response.end("event: error\ndata: {\"code\":\"SERVICE_UNAVAILABLE\",\"message\":\"语音合成服务暂不可用\"}\n\n");
            }
            return;
          }
          if (!timedOut && !response.writableEnded) response.end("event: done\ndata: {}\n\n");
        } catch (error) {
          if (!timedOut && !response.writableEnded) {
            response.end(`event: error\ndata: ${JSON.stringify({ code: "INTERNAL_ERROR", message: "流式语音合成失败" })}\n\n`);
          }
          if (!streamOk) throw error;
        }
        return;
      }
      if (pathname === "/v1/conversations/messages") {
        requireMethod(request, "POST");
        requireJsonContentType(request);
        const body = await readJsonBody(request, maxBodyBytes);
        validateMessageEnvelope(body);
        const result = await assistant.sendMessage(body, { actorId, scopeId });
        if (!timedOut && !response.writableEnded) writeJson(response, 200, result, corsHeaders);
        return;
      }
      const messagesMatch = /^\/v1\/conversations\/([^/]+)\/messages$/.exec(pathname);
      if (messagesMatch) {
        const conversationId = decodeURIComponent(messagesMatch[1]);
        if (!conversationId) throw new HttpTransportError(400, "INVALID_REQUEST", "会话标识无效。");
        if (request.method === "GET") {
          const messages = await assistant.repository.listMessages(conversationId);
          if (!timedOut && !response.writableEnded) writeJson(response, 200, { contractVersion: "1.0.0", conversationId, messages, count: messages.length }, corsHeaders);
          return;
        }
        if (request.method === "DELETE") {
          requireJsonContentType(request);
          const body = await readJsonBody(request, maxBodyBytes);
          validateDeleteMessagesBody(body);
          const deleted = await assistant.repository.deleteMessages(conversationId, body.messageIds);
          if (!timedOut && !response.writableEnded) writeJson(response, 200, { deleted, conversationId }, corsHeaders);
          return;
        }
        requireMethod(request, "GET");
        return;
      }
      throw new HttpTransportError(404, "INVALID_REQUEST", "未找到该 HTTP 路由。");
    } catch (error) {
      if (!timedOut && !response.writableEnded) writeError(response, requestId, normalizeHttpError(error), corsHeaders);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  });

  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;

  async function start() {
    if (listening) return address();
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    listening = true;
    return address();
  }

  async function close() {
    if (rateSweeper) clearInterval(rateSweeper);
    if (!listening) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        listening = false;
        resolve();
      };
      const forceTimer = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, requestTimeoutMs);
      forceTimer.unref?.();
      server.close(finish);
      server.closeIdleConnections?.();
    });
  }

  function address() {
    const value = server.address();
    if (!value || typeof value === "string") return null;
    return { host: value.address, port: value.port, family: value.family, url: `http://${formatHost(value.address)}:${value.port}` };
  }

  return { assistant, server, start, close, address };
}

function normalizeOrigins(value) {
  const entries = typeof value === "string" ? value.split(",") : value;
  return new Set([...entries].map((origin) => origin.trim()).filter(Boolean));
}

function isHttpsOrigin(origin) {
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function validateLoginBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpTransportError(400, "INVALID_REQUEST", "登录请求格式无效。");
  if (Object.keys(value).some((key) => key !== "username" && key !== "password")) throw new HttpTransportError(400, "INVALID_REQUEST", "登录请求包含未定义字段。");
  if (typeof value.username !== "string" || !value.username || value.username.length > 64) throw new HttpTransportError(400, "INVALID_REQUEST", "用户名格式无效。");
  if (typeof value.password !== "string" || value.password.length > 128) throw new HttpTransportError(400, "INVALID_REQUEST", "密码格式无效。");
}

function verifyAdminLogin(adminPasswordHash, username, password) {
  if (!adminPasswordHash) return false;
  if (username !== "admin") return false;
  const salt = Buffer.from(adminPasswordHash.slice(0, 64), "hex");
  const expected = Buffer.from(adminPasswordHash.slice(64, 192), "hex");
  if (salt.length !== 32 || expected.length !== 64) return false;
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isRateLimitedPath(pathname) {
  // 语音链路（ASR 上传 / TTS 合成）不占配额：一轮语音对话 = ASR + 主对话 + TTS 三次请求，
  // 若全部计入 10 次/分钟配额，说三句话就会被 429 拦截。
  return pathname === "/v1/conversations/messages";
}

function hasActiveSession(sessions, token, now) {
  const expiresAt = sessions.get(token);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function clientIp(request) {
  const forwarded = request.headers["cf-connecting-ip"];
  const raw = (typeof forwarded === "string" && forwarded.trim() ? forwarded.trim() : request.socket.remoteAddress ?? "").split(",")[0].trim();
  // 只接受可信的 IPv4（后端只监听 127.0.0.1、只能经 cloudflared 触达时该头不可伪造）。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw;
  if (raw.startsWith("::ffff:") && /^\d{1,3}(\.\d{1,3}){3}$/.test(raw.slice(7))) return raw.slice(7);
  return null;
}

function isRateLimited(rateBuckets, ip, rateLimitMax) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket) {
    rateBuckets.set(ip, [now]);
    return false;
  }
  const cutoff = now - 60_000;
  while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
  if (bucket.length >= rateLimitMax) return true;
  bucket.push(now);
  return false;
}

function sweepRateBuckets(rateBuckets) {
  if (!rateBuckets) return;
  const cutoff = Date.now() - 60_000;
  for (const [ip, bucket] of rateBuckets) {
    while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
    if (bucket.length === 0) rateBuckets.delete(ip);
  }
}

function parsePathname(rawUrl) {
  try {
    return new URL(rawUrl ?? "/", "http://local.invalid").pathname;
  } catch {
    throw new HttpTransportError(400, "INVALID_REQUEST", "HTTP 路径无效。");
  }
}

function requireMethod(request, expected) {
  if (request.method !== expected) throw new HttpTransportError(405, "INVALID_REQUEST", "该路由不支持此 HTTP 方法。", false, { Allow: expected });
}

function requireJsonContentType(request) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new HttpTransportError(415, "INVALID_REQUEST", "Content-Type 必须是 application/json。");
  }
}

function validatePreflight(request) {
  const requestedMethod = request.headers["access-control-request-method"];
  if (requestedMethod && !["GET", "POST", "DELETE"].includes(requestedMethod.toUpperCase())) throw new HttpTransportError(400, "INVALID_REQUEST", "预检请求的方法不受支持。");
  const requestedHeaders = String(request.headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => header !== "content-type" && header !== "x-api-key" && header !== "authorization")) throw new HttpTransportError(400, "INVALID_REQUEST", "预检请求只允许 Content-Type、X-Api-Key 和 Authorization 请求头。");
}

function parseAudioContentType(contentType) {
  if (typeof contentType !== "string") return "audio/wav";
  const base = contentType.split(";", 1)[0].trim().toLowerCase();
  if (!base.startsWith("audio/")) return "audio/wav";
  return base;
}

async function readRawBody(request, maxBytes) {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new HttpTransportError(413, "INPUT_TOO_LONG", "请求体超过大小限制。");
  const chunks = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      exceeded = true;
      chunks.length = 0;
      continue;
    }
    if (!exceeded) chunks.push(chunk);
  }
  if (exceeded) throw new HttpTransportError(413, "INPUT_TOO_LONG", "请求体超过大小限制。");
  if (chunks.length === 0) throw new HttpTransportError(400, "INVALID_REQUEST", "请求体不能为空。");
  return Buffer.concat(chunks);
}

async function readJsonBody(request, maxBodyBytes) {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) throw new HttpTransportError(413, "INPUT_TOO_LONG", "请求体超过 64 KiB 限制。");
  const chunks = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      exceeded = true;
      chunks.length = 0;
      continue;
    }
    if (!exceeded) chunks.push(chunk);
  }
  if (exceeded) throw new HttpTransportError(413, "INPUT_TOO_LONG", "请求体超过 64 KiB 限制。");
  const text = Buffer.concat(chunks).toString("utf8");
  assertJsonDepth(text, 64);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpTransportError(400, "INVALID_REQUEST", "请求体不是有效 JSON。");
  }
}

// 按括号深度粗略守卫，防止极端嵌套的 JSON 解析卡死 CPU；跳过字符串字面量以不误判内容里的括号。
function assertJsonDepth(text, maxDepth) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      depth++;
      if (depth > maxDepth) throw new HttpTransportError(400, "INVALID_REQUEST", "请求体嵌套过深。");
    } else if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
}

function validateMessageEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpTransportError(400, "INVALID_REQUEST", "消息请求格式无效。");
  const allowed = new Set(["contractVersion", "conversationId", "clientMessageId", "idempotencyKey", "message", "locale", "timezone", "continuation", "city"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new HttpTransportError(400, "INVALID_REQUEST", "消息请求包含未定义字段。");
  if (value.city !== undefined && typeof value.city !== "string") throw new HttpTransportError(400, "INVALID_REQUEST", "city 字段格式无效。");
  if (value.contractVersion !== "1.0.0") throw new HttpTransportError(400, "CONTRACT_VERSION_UNSUPPORTED", "不支持的契约版本。");
  for (const field of ["conversationId", "clientMessageId", "idempotencyKey", "message", "locale", "timezone"]) {
    if (typeof value[field] !== "string") throw new HttpTransportError(400, "INVALID_REQUEST", "消息请求缺少必需字符串字段。");
  }
  if (value.continuation !== undefined) {
    if (!value.continuation || typeof value.continuation !== "object" || Array.isArray(value.continuation)
      || !["clarification", "confirmation"].includes(value.continuation.type) || typeof value.continuation.id !== "string"
      || Object.keys(value.continuation).some((key) => !["type", "id"].includes(key))) {
      throw new HttpTransportError(400, "INVALID_REQUEST", "continuation 格式无效。");
    }
  }
}

function validateDeleteMessagesBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpTransportError(400, "INVALID_REQUEST", "删除请求格式无效。");
  if (Object.keys(value).some((key) => key !== "messageIds")) throw new HttpTransportError(400, "INVALID_REQUEST", "删除请求包含未定义字段。");
  if (!Array.isArray(value.messageIds) || value.messageIds.some((id) => typeof id !== "string" || !id)) {
    throw new HttpTransportError(400, "INVALID_REQUEST", "messageIds 必须是字符串数组。");
  }
}

function validateSpeakBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpTransportError(400, "INVALID_REQUEST", "语音合成请求格式无效。");
  if (Object.keys(value).some((key) => key !== "text" && key !== "voice")) throw new HttpTransportError(400, "INVALID_REQUEST", "语音合成请求包含未定义字段。");
  if (typeof value.text !== "string" || !value.text.trim()) throw new HttpTransportError(400, "INVALID_REQUEST", "text 必须是非空字符串。");
  if (value.voice !== undefined && (typeof value.voice !== "string" || !value.voice.trim())) throw new HttpTransportError(400, "INVALID_REQUEST", "voice 格式无效。");
}

function normalizeHttpError(error) {
  if (error instanceof HttpTransportError) return error;
  return new HttpTransportError(500, "INTERNAL_ERROR", "HTTP 服务暂时不可用。", true);
}

function writeError(response, requestId, error, corsHeaders) {
  writeJson(response, error.status, { code: error.code, message: error.message, retryable: error.retryable, requestId }, { ...corsHeaders, ...error.headers });
}

function writeJson(response, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(payload);
}
