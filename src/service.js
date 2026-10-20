import { appError, normalizeError } from "./http.js";
import { checkAuthFile, isCodexFile, listAuthFiles, promisePool } from "./cpa.js";
import { loadSnapshot, saveSnapshot } from "./store.js";

// Workers 免费版单次请求最多 50 个外部子请求，检测按批执行，每批最多 40 个。
export const MAX_BATCH = 40;
const CRON_BUDGET = 45;

export function enabledInstances(config, instanceId = "") {
  const list = config.instances.filter((item) => item.enabled);
  if (!instanceId) return list;
  const found = list.find((item) => item.id === instanceId);
  if (!found) throw appError("INSTANCE_NOT_FOUND", `CPA 实例不存在: ${instanceId}`, 404);
  return [found];
}

function targetFiles(config, entry) {
  return (entry?.files || []).filter((file) => !(config.check.skipDisabled && file.disabled));
}

async function scanInstance(instance, config, previous) {
  const listedAt = new Date().toISOString();
  try {
    const files = (await listAuthFiles(instance, config.check.timeoutMs)).filter(isCodexFile);
    const keep = new Set(files.map((file) => file.id));
    const checks = Object.fromEntries(Object.entries(previous?.checks || {}).filter(([fileId]) => keep.has(fileId)));
    return { id: instance.id, ok: true, error: null, listedAt, files, checks };
  } catch (error) {
    return { ...(previous || { files: [], checks: {} }), id: instance.id, ok: false, error: normalizeError(error).message, listedAt };
  }
}

/** 拉取认证文件列表，返回检测计划。公开访客在缓存期内直接复用。 */
export async function scan(env, config, { instanceId = "", admin = false } = {}) {
  const snapshot = await loadSnapshot(env);
  const instances = enabledInstances(config, instanceId);
  const fresh = !admin && isFresh(snapshot.listedAt, config.public.cacheSeconds);

  if (!fresh) {
    const results = await Promise.all(instances.map((instance) => scanInstance(instance, config, snapshot.instances?.[instance.id])));
    snapshot.instances = snapshot.instances || {};
    for (const entry of results) snapshot.instances[entry.id] = entry;
    snapshot.listedAt = new Date().toISOString();
    await saveSnapshot(env, snapshot);
  }

  const plan = instances.map((instance) => ({
    instanceId: instance.id,
    total: targetFiles(config, snapshot.instances?.[instance.id]).length,
  }));
  return { snapshot, plan, cached: fresh };
}

/** 检测某个实例中 [offset, offset + limit) 范围内的认证文件。 */
export async function checkBatch(env, config, { instanceId, offset = 0, limit = MAX_BATCH, admin = false }) {
  if (!instanceId) throw appError("BAD_REQUEST", "缺少 instanceId", 400);
  const [instance] = enabledInstances(config, String(instanceId));
  const snapshot = await loadSnapshot(env);
  const entry = snapshot.instances?.[instance.id];
  if (!entry) throw appError("NOT_SCANNED", "请先刷新认证文件列表", 409);

  const start = Math.max(0, Number.parseInt(offset, 10) || 0);
  const size = Math.min(MAX_BATCH, Math.max(1, Number.parseInt(limit, 10) || MAX_BATCH));
  const files = targetFiles(config, entry).slice(start, start + size);
  const cacheSeconds = config.public.cacheSeconds;
  const pending = files.filter((file) => admin || !isFresh(entry.checks?.[file.id]?.checkedAt, cacheSeconds));

  const results = await promisePool(pending, config.check.concurrency, (file) => checkAuthFile(instance, file, config.check));
  if (results.length > 0) {
    entry.checks = entry.checks || {};
    for (const result of results) entry.checks[result.fileId] = result;
    snapshot.checkedAt = new Date().toISOString();
    await saveSnapshot(env, snapshot);
  }
  return { snapshot, checked: results.length, reused: files.length - results.length };
}

/** Cron：按“最久未检测优先”的顺序补检，单次不超过子请求预算。 */
export async function runScheduled(env, config) {
  const minutes = config.check.autoCheckMinutes;
  if (!minutes) return { skipped: "disabled" };
  const instances = enabledInstances(config);
  if (instances.length === 0) return { skipped: "no-instances" };

  const snapshot = await loadSnapshot(env);
  snapshot.instances = snapshot.instances || {};
  let budget = CRON_BUDGET;

  if (!isFresh(snapshot.listedAt, minutes * 60)) {
    const results = await Promise.all(instances.map((instance) => scanInstance(instance, config, snapshot.instances[instance.id])));
    for (const entry of results) snapshot.instances[entry.id] = entry;
    snapshot.listedAt = new Date().toISOString();
    budget -= instances.length;
  }

  const due = [];
  for (const instance of instances) {
    const entry = snapshot.instances[instance.id];
    if (!entry?.ok) continue;
    for (const file of targetFiles(config, entry)) {
      const checkedAt = entry.checks?.[file.id]?.checkedAt;
      if (!isFresh(checkedAt, minutes * 60)) due.push({ instance, entry, file, at: checkedAt ? Date.parse(checkedAt) : 0 });
    }
  }
  due.sort((a, b) => a.at - b.at);
  const picked = due.slice(0, Math.max(0, budget));

  await promisePool(picked, config.check.concurrency, async ({ instance, entry, file }) => {
    const result = await checkAuthFile(instance, file, config.check);
    entry.checks = entry.checks || {};
    entry.checks[file.id] = result;
  });
  if (picked.length > 0) snapshot.checkedAt = new Date().toISOString();
  await saveSnapshot(env, snapshot);
  return { checked: picked.length, remaining: due.length - picked.length };
}

/** 生成返回给前端的视图；非管理员只拿到脱敏数据。 */
export function buildView(snapshot, config, { admin = false } = {}) {
  const mask = !admin && config.public.privacyMode;
  const instances = enabledInstances(config).map((instance) => {
    const entry = snapshot.instances?.[instance.id];
    const files = (entry?.files || []).map((file, index) => {
      const skipped = config.check.skipDisabled && file.disabled;
      const check = skipped
        ? { status: "skipped", statusCode: null, latencyMs: 0, message: "已禁用，跳过检测", quotaBars: [], checkedAt: null }
        : stripFileId(entry.checks?.[file.id]);
      const view = {
        id: mask ? maskName(file.id, index) : file.id,
        provider: file.provider,
        authIndex: mask ? "•••" : String(file.authIndex ?? ""),
        disabled: file.disabled,
        accountId: mask ? maskTail(file.accountId) : file.accountId,
        email: mask ? maskEmail(file.email) : file.email,
        check,
      };
      return view;
    });
    return {
      id: instance.id,
      name: instance.name,
      host: admin ? hostOf(instance.baseUrl) : null,
      ok: entry ? entry.ok : null,
      error: entry?.error || null,
      listedAt: entry?.listedAt || null,
      files,
    };
  });

  return {
    instances,
    summary: summarize(instances),
    listedAt: snapshot.listedAt || null,
    checkedAt: snapshot.checkedAt || null,
    masked: mask,
  };
}

export function summarize(instances) {
  const summary = {
    instances: instances.length,
    healthyInstances: 0,
    errorInstances: 0,
    total: 0,
    checked: 0,
    ok: 0,
    invalid401: 0,
    limited: 0,
    errors: 0,
    disabled: 0,
    unchecked: 0,
  };
  for (const instance of instances) {
    if (instance.ok === false) summary.errorInstances += 1;
    else if (instance.ok) summary.healthyInstances += 1;
    for (const file of instance.files) {
      summary.total += 1;
      if (file.disabled) summary.disabled += 1;
      const status = file.check?.status || "unchecked";
      if (status === "unchecked") summary.unchecked += 1;
      else if (status !== "skipped") summary.checked += 1;
      if (status === "ok") summary.ok += 1;
      if (status === "invalid_401") summary.invalid401 += 1;
      if (status === "limited") summary.limited += 1;
      if (status === "upstream_error" || status === "check_error") summary.errors += 1;
    }
  }
  return summary;
}

function stripFileId(check) {
  if (!check) return null;
  const { fileId, ...rest } = check;
  return rest;
}

function isFresh(iso, seconds) {
  if (!iso || !seconds) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && Date.now() - time < seconds * 1000;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function maskName(id, index) {
  const ext = /\.json$/i.test(id) ? ".json" : "";
  return `account-${String(index + 1).padStart(3, "0")}${ext}`;
}

function maskTail(value) {
  if (!value) return "";
  return `••••${value.slice(-4)}`;
}

function maskEmail(value) {
  if (!value || !value.includes("@")) return value ? "••••" : "";
  const [name, domain] = value.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
}
