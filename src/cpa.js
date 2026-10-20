import { appError, normalizeError } from "./http.js";

const USER_AGENT = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";

export async function cpaFetchJson(instance, path, { method = "GET", body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${instance.accessKey}`,
      "Cache-Control": "no-cache",
    };
    const init = { method, headers, signal: controller.signal };
    if (body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(`${instance.baseUrl}${path}`, init);
    } catch (error) {
      if (error && error.name === "AbortError") throw appError("CPA_TIMEOUT", `CPA 请求超时 (${timeoutMs}ms)`, 504);
      throw appError("CPA_UNREACHABLE", `无法连接 CPA：${error.message || error}`, 502);
    }
    const text = await response.text();
    const data = parseJson(text);

    if (response.status === 401 || response.status === 403) {
      throw appError("CPA_AUTH_FAILED", `CPA 管理密钥无效 (HTTP ${response.status})`, 502);
    }
    if (!response.ok) {
      const message = data && typeof data === "object" ? data.message || data.error || JSON.stringify(data) : text;
      throw appError("CPA_HTTP_ERROR", `CPA HTTP ${response.status}: ${truncate(String(message || "empty"), 160)}`, 502);
    }
    if (!data || typeof data !== "object") throw appError("CPA_BAD_RESPONSE", "CPA 响应不是 JSON", 502);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function listAuthFiles(instance, timeoutMs) {
  const data = await cpaFetchJson(instance, "/v0/management/auth-files", { timeoutMs });
  if (!Array.isArray(data.files)) throw appError("CPA_BAD_RESPONSE", "CPA 响应缺少 files 数组", 502);
  return data.files.map(normalizeAuthFile).filter((file) => file.id);
}

export function normalizeAuthFile(item) {
  const source = item && typeof item === "object" ? item : {};
  return {
    id: String(source.id || source.name || "").trim(),
    provider: String(source.provider || source.provider_name || source.type || "unknown"),
    authIndex: source.auth_index ?? source.authIndex ?? "",
    disabled: Boolean(source.disabled),
    accountId: String(source.id_token?.chatgpt_account_id || source.chatgpt_account_id || ""),
    email: String(source.email || source.id_token?.email || ""),
  };
}

export function isCodexFile(file) {
  const provider = file.provider.toLowerCase();
  const id = file.id.toLowerCase();
  const isGemini = provider.includes("gemini") || id.startsWith("gemini-") || id.includes("/gemini");
  const isCodex = provider.includes("codex") || id.startsWith("codex-") || file.accountId.toLowerCase().includes("chatgpt");
  return isCodex && !isGemini;
}

export async function checkAuthFile(instance, file, check) {
  const startedAt = Date.now();
  const base = { fileId: file.id, checkedAt: new Date().toISOString() };
  try {
    const data = await cpaFetchJson(instance, "/v0/management/api-call", {
      method: "POST",
      timeoutMs: check.timeoutMs,
      body: {
        authIndex: file.authIndex,
        method: "GET",
        url: check.targetUrl,
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "Chatgpt-Account-Id": file.accountId || "",
        },
      },
    });
    const statusCode = Number(data.status_code ?? data.statusCode);
    if (!Number.isFinite(statusCode)) throw appError("CPA_BAD_CHECK_RESPONSE", "检测响应缺少 status_code", 502);
    const parsedBody = typeof data.body === "string" ? parseJson(data.body) ?? data.body : data.body;
    return {
      ...base,
      status: classifyStatus(statusCode, parsedBody),
      statusCode,
      latencyMs: Date.now() - startedAt,
      message: statusMessage(statusCode, parsedBody),
      plan: extractPlan(parsedBody),
      quotaBars: extractQuotaBars(parsedBody),
    };
  } catch (error) {
    return {
      ...base,
      status: "check_error",
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      message: normalizeError(error).message,
      plan: null,
      quotaBars: [],
    };
  }
}

export function classifyStatus(statusCode, body) {
  if (statusCode === 401) return "invalid_401";
  if (statusCode === 403 || statusCode === 429) return "limited";
  if (statusCode >= 200 && statusCode < 300) return "ok";
  if (statusCode >= 500) return "upstream_error";
  const text = stringify(body).toLowerCase();
  if (text.includes("rate limit") || text.includes("usage limit") || text.includes("quota")) return "limited";
  return "check_error";
}

function statusMessage(statusCode, body) {
  if (statusCode === 401) return "认证失效或 token 不可用";
  if (statusCode === 403) return "请求被拒绝，可能是权限或额度限制";
  if (statusCode === 429) return "触发速率或额度限制";
  if (statusCode >= 200 && statusCode < 300) return "可用";
  if (statusCode >= 500) return "上游服务异常";
  return truncate(stringify(body), 160) || `HTTP ${statusCode}`;
}

function extractPlan(body) {
  if (!body || typeof body !== "object") return null;
  const plan = body.plan_type ?? body.plan ?? body.account_plan ?? body.usage?.plan;
  return typeof plan === "string" ? plan.slice(0, 40) : null;
}

export function extractQuotaBars(body) {
  if (!body || typeof body !== "object") return [];
  const bars = [];
  const seen = new Set();

  function addBar(label, percent, resetAt) {
    const value = Number(percent);
    if (!Number.isFinite(value)) return;
    const used = Math.round(Math.max(0, Math.min(100, value)));
    const key = `${label}:${used}:${resetAt || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    bars.push({ label, percent: used, resetAt: resetAt || null });
  }

  function scan(node, path) {
    if (!node || typeof node !== "object" || bars.length >= 8) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => scan(item, [...path, String(index)]));
      return;
    }

    const label = String(node.label || node.name || node.title || inferLabel(path));
    const resetAt =
      normalizeResetAt(node.reset_at ?? node.resetAt ?? node.resets_at ?? node.resetsAt ?? node.next_reset_at) ||
      inferResetAt(node);
    const direct =
      node.percent ??
      node.percentage ??
      node.used_percent ??
      node.usedPercentage ??
      node.usage_percent ??
      ratioToPercent(node.used_ratio ?? node.usage_ratio);

    if (direct !== undefined && direct !== null) addBar(label, direct, resetAt);

    const used = Number(node.used ?? node.consumed ?? node.current ?? node.total_used);
    const limit = Number(node.limit ?? node.total ?? node.max ?? node.capacity ?? node.quota);
    const remaining = Number(node.remaining ?? node.available ?? node.left);
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) addBar(label, (used / limit) * 100, resetAt);
    else if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) addBar(label, ((limit - remaining) / limit) * 100, resetAt);

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") scan(value, [...path, key]);
    }
  }

  scan(body, []);
  return bars;
}

function inferLabel(path) {
  const text = path.join(".").toLowerCase();
  const scope = text.includes("code_review") ? "代码审查 " : "";
  if (text.includes("primary_window")) return `${scope}5 小时限额`;
  if (text.includes("secondary_window")) return `${scope}周限额`;
  if (text.includes("weekly") || text.includes("week")) return `${scope}周限额`;
  if (text.includes("daily") || text.includes("day")) return `${scope}日限额`;
  if (text.includes("hour") || text.includes("5h")) return `${scope}5 小时限额`;
  if (text.includes("codex")) return "Codex 额度";
  return "额度";
}

function inferResetAt(node) {
  const seconds = Number(node.reset_after_seconds ?? node.resetAfterSeconds ?? node.reset_in_seconds ?? node.resetInSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizeResetAt(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "number" ? value : /^\d+$/.test(String(value).trim()) ? Number(value) : null;
  if (numeric !== null) {
    const date = new Date(numeric > 1e11 ? numeric : numeric * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ratioToPercent(value) {
  const parsed = Number(value);
  if (value === undefined || value === null || !Number.isFinite(parsed)) return undefined;
  return parsed <= 1 ? parsed * 100 : parsed;
}

export async function promisePool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringify(body) {
  if (body === null || body === undefined) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
