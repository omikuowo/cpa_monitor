import { appError } from "./http.js";

const KEYS = {
  config: "config:v2",
  auth: "auth:v2",
  snapshot: "snapshot:v2",
};

export const DEFAULT_TARGET_URL = "https://chatgpt.com/backend-api/wham/usage";

export const COMPONENTS = ["hero", "metrics", "quota", "auth-files", "logs"];

export function defaultConfig() {
  return {
    instances: [],
    check: {
      targetUrl: DEFAULT_TARGET_URL,
      timeoutMs: 30000,
      concurrency: 8,
      skipDisabled: true,
      autoCheckMinutes: 0,
    },
    public: {
      access: "public",
      allowCheck: true,
      cacheSeconds: 60,
      privacyMode: false,
    },
    display: {
      siteName: "CPA 额度监测",
      components: Object.fromEntries(COMPONENTS.map((key) => [key, true])),
    },
  };
}

export function getKv(env) {
  return env.CPA_MONITOR_KV || null;
}

function requireKv(env) {
  const kv = getKv(env);
  if (!kv) {
    throw appError(
      "KV_NOT_BOUND",
      "未绑定 KV 存储（CPA_MONITOR_KV）。请使用一键部署，或在 wrangler.toml 中保留 kv_namespaces 配置后重新部署。",
      503,
    );
  }
  return kv;
}

async function readJson(env, key) {
  const kv = getKv(env);
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(env, key, value, options) {
  await requireKv(env).put(key, JSON.stringify(value), options);
}

// ---------- 配置 ----------

export async function loadConfig(env) {
  const stored = (await readJson(env, KEYS.config)) || {};
  const config = mergeConfig(defaultConfig(), stored);
  // 兼容旧版：环境变量里的 CPA 实例以只读方式附加。
  for (const instance of envInstances(env)) {
    if (!config.instances.some((item) => item.id === instance.id)) config.instances.push(instance);
  }
  return config;
}

export async function saveConfig(env, config) {
  const persistable = { ...config, instances: config.instances.filter((item) => !item.fromEnv) };
  await writeJson(env, KEYS.config, persistable);
}

export function mergeConfig(base, patch) {
  const next = structuredClone(base);
  if (!patch || typeof patch !== "object") return next;

  if (Array.isArray(patch.instances)) {
    next.instances = patch.instances.map(normalizeInstance).filter(Boolean).slice(0, 50);
  }

  if (patch.check && typeof patch.check === "object") {
    const c = patch.check;
    if (typeof c.targetUrl === "string" && /^https?:\/\//i.test(c.targetUrl.trim())) next.check.targetUrl = c.targetUrl.trim();
    if (c.timeoutMs !== undefined) next.check.timeoutMs = clampInt(c.timeoutMs, 3000, 120000, next.check.timeoutMs);
    if (c.concurrency !== undefined) next.check.concurrency = clampInt(c.concurrency, 1, 20, next.check.concurrency);
    if (typeof c.skipDisabled === "boolean") next.check.skipDisabled = c.skipDisabled;
    if (c.autoCheckMinutes !== undefined) next.check.autoCheckMinutes = clampInt(c.autoCheckMinutes, 0, 1440, 0);
  }

  if (patch.public && typeof patch.public === "object") {
    const p = patch.public;
    if (p.access === "public" || p.access === "private") next.public.access = p.access;
    if (typeof p.allowCheck === "boolean") next.public.allowCheck = p.allowCheck;
    if (p.cacheSeconds !== undefined) next.public.cacheSeconds = clampInt(p.cacheSeconds, 10, 86400, next.public.cacheSeconds);
    if (typeof p.privacyMode === "boolean") next.public.privacyMode = p.privacyMode;
  }

  if (patch.display && typeof patch.display === "object") {
    const d = patch.display;
    if (typeof d.siteName === "string" && d.siteName.trim()) next.display.siteName = d.siteName.trim().slice(0, 40);
    if (d.components && typeof d.components === "object") {
      for (const key of COMPONENTS) {
        if (typeof d.components[key] === "boolean") next.display.components[key] = d.components[key];
      }
    }
  }

  return next;
}

export function normalizeInstance(item, index = 0) {
  if (!item || typeof item !== "object") return null;
  const baseUrl = normalizeBaseUrl(item.baseUrl || item.base_url || "");
  const accessKey = String(item.accessKey || item.access_key || "").trim();
  if (!baseUrl || !accessKey) return null;
  const name = String(item.name || "").trim().slice(0, 60) || hostOf(baseUrl) || `CPA ${index + 1}`;
  return {
    id: slugify(item.id || name || baseUrl),
    name,
    baseUrl,
    accessKey,
    enabled: item.enabled !== false,
    ...(item.fromEnv ? { fromEnv: true } : {}),
  };
}

// 把前端提交的实例列表合并进已有配置：accessKey 留空表示保持原值。
export function applyInstancePatch(current, incoming) {
  if (!Array.isArray(incoming)) throw appError("BAD_INSTANCES", "instances 必须是数组", 400);
  const byId = new Map(current.map((item) => [item.id, item]));
  const result = [];
  const usedIds = new Set();

  for (const [index, raw] of incoming.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const previous = raw.id ? byId.get(String(raw.id)) : null;
    if (previous?.fromEnv) {
      result.push(previous);
      usedIds.add(previous.id);
      continue;
    }
    const merged = normalizeInstance(
      {
        ...raw,
        accessKey: String(raw.accessKey || "").trim() || previous?.accessKey || "",
      },
      index,
    );
    if (!merged) {
      throw appError("BAD_INSTANCE", `第 ${index + 1} 个实例缺少地址或管理密钥`, 400);
    }
    if (!/^https?:\/\//i.test(merged.baseUrl)) {
      throw appError("BAD_INSTANCE", `实例 ${merged.name} 的地址必须以 http:// 或 https:// 开头`, 400);
    }
    let id = previous ? previous.id : merged.id;
    let suffix = 2;
    while (usedIds.has(id)) id = `${merged.id}-${suffix++}`;
    usedIds.add(id);
    result.push({ ...merged, id });
  }

  for (const item of current) {
    if (item.fromEnv && !usedIds.has(item.id)) result.push(item);
  }
  return result;
}

function envInstances(env) {
  const list = [];
  const raw = env.CPA_INSTANCES_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((item, index) => {
          const instance = normalizeInstance({ ...item, fromEnv: true }, index);
          if (instance) list.push(instance);
        });
      }
    } catch {
      // 忽略无效的旧版配置，网页设置才是主要入口。
    }
  }
  const single = normalizeInstance({
    id: env.CPA_INSTANCE_ID || "env-main",
    name: env.CPA_INSTANCE_NAME || "Main CPA",
    baseUrl: env.CPA_BASE_URL,
    accessKey: env.CPA_ACCESS_KEY,
    fromEnv: true,
  });
  if (single && !list.some((item) => item.id === single.id)) list.push(single);
  return list;
}

// ---------- 认证 ----------

export function loadAuth(env) {
  return readJson(env, KEYS.auth);
}

export function saveAuth(env, auth) {
  return writeJson(env, KEYS.auth, auth);
}

// ---------- 快照 ----------

export async function loadSnapshot(env) {
  const snapshot = await readJson(env, KEYS.snapshot);
  return snapshot && typeof snapshot === "object" ? snapshot : { instances: {}, listedAt: null, checkedAt: null };
}

export function saveSnapshot(env, snapshot) {
  return writeJson(env, KEYS.snapshot, snapshot);
}

// ---------- 速率限制（KV 计数，粗粒度即可） ----------

export async function hitRateLimit(env, bucket, limit, windowSeconds) {
  const kv = getKv(env);
  if (!kv) return { limited: false };
  const slot = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${slot}`;
  const count = Number((await kv.get(key)) || 0);
  if (count >= limit) return { limited: true };
  await kv.put(key, String(count + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
  return { limited: false };
}

// ---------- 工具 ----------

export function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function slugify(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `cpa-${Math.random().toString(36).slice(2, 8)}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
