import { readFileSync } from "node:fs";

const LOADED_PREFIXES = ["DEEPSEEK_", "TAVILY_", "DASHSCOPE_", "MIMO_"];

/**
 * Minimal local .env loader. Only whitelisted prefixes are loaded, existing
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
    if (!LOADED_PREFIXES.some((prefix) => key.startsWith(prefix)) || process.env[key] !== undefined) continue;
    process.env[key] = match[2].trim();
  }
}
