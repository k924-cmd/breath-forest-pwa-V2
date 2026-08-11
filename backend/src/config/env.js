import { readFileSync } from "node:fs";

const LOADED_PREFIXES = ["DEEPSEEK_", "TAVILY_", "DASHSCOPE_", "MIMO_"];
// 部署配置键：认证 / 限流 / CORS，不进列表就加载不了 .env，导致按文档配置无效。
const LOADED_KEYS = new Set(["API_KEY", "ADMIN_PASSWORD_HASH", "RATE_LIMIT_ENABLED", "RATE_LIMIT_PER_MINUTE", "HOST", "PORT", "ALLOWED_ORIGINS", "ALLOW_ORIGINS_WILDCARD", "SQLITE_ENABLED", "SQLITE_DB_PATH"]);

/**
 * Minimal local .env loader. Only whitelisted prefixes/keys are loaded, existing
 * process environment values are never overwritten, and no value is logged
 * or printed. Missing files are ignored so defaults keep working.
 */
export function loadDotEnvIfPresent(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    if (!LOADED_PREFIXES.some((prefix) => key.startsWith(prefix)) && !LOADED_KEYS.has(key)) continue;
    process.env[key] = match[2].trim();
  }
}
