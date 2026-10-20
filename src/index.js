import { appError, clientIp, fail, ok, readBody } from "./http.js";
import {
  clearSessionCookie,
  createAuthRecord,
  currentSession,
  issueSession,
  validatePassword,
  verifyPassword,
} from "./auth.js";
import {
  applyInstancePatch,
  defaultConfig,
  getKv,
  hitRateLimit,
  loadConfig,
  loadSnapshot,
  mergeConfig,
  normalizeInstance,
  saveAuth,
  saveConfig,
} from "./store.js";
import { MAX_BATCH, buildView, checkBatch, runScheduled, scan } from "./service.js";
import { isCodexFile, listAuthFiles } from "./cpa.js";

const VERSION = "2.0.0";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (!getKv(env)) return;
        const config = await loadConfig(env);
        await runScheduled(env, config);
      })().catch((error) => console.error("scheduled check failed", error)),
    );
  },
};

async function handleApi(request, env, url) {
  const route = `${request.method} ${url.pathname.replace(/\/+$/, "")}`;
  try {
    const handler = ROUTES[route];
    if (!handler) throw appError("NOT_FOUND", `未知接口 ${route}`, 404);
    const session = await currentSession(request, env);
    const body = await readBody(request);
    return await handler({ request, env, url, body, session });
  } catch (error) {
    return fail(error);
  }
}

function requireAdmin(session) {
  if (!session.initialized) throw appError("NOT_INITIALIZED", "站点尚未初始化", 409);
  if (!session.admin) throw appError("UNAUTHORIZED", "请先登录管理员", 401);
}

function requireViewer(session, config) {
  if (!session.initialized) throw appError("NOT_INITIALIZED", "站点尚未初始化", 409);
  if (!session.admin && config.public.access === "private") {
    throw appError("PRIVATE_SITE", "该站点仅管理员可见，请先登录", 401);
  }
}

function publicSettings(config) {
  return {
    siteName: config.display.siteName,
    components: config.display.components,
    access: config.public.access,
    allowCheck: config.public.allowCheck,
    privacyMode: config.public.privacyMode,
    cacheSeconds: config.public.cacheSeconds,
    autoCheckMinutes: config.check.autoCheckMinutes,
    batchSize: MAX_BATCH,
  };
}

function adminSettings(config) {
  return {
    ...config,
    instances: config.instances.map(({ accessKey, ...rest }) => ({
      ...rest,
      accessKeyHint: accessKey ? `••••${accessKey.slice(-4)}` : "",
    })),
  };
}

const ROUTES = {
  "GET /api/health": () => ok({ status: "ok", version: VERSION }),

  async "GET /api/bootstrap"({ env, session }) {
    const config = await loadConfig(env);
    return ok({
      version: VERSION,
      initialized: session.initialized,
      admin: session.admin,
      kvBound: Boolean(getKv(env)),
      setupTokenRequired: Boolean(env.SETUP_TOKEN),
      passwordFromEnv: Boolean(String(env.ADMIN_PASSWORD || "").trim()),
      instanceCount: config.instances.filter((item) => item.enabled).length,
      settings: publicSettings(config),
    });
  },

  async "POST /api/setup"({ request, env, body, session }) {
    if (session.initialized) throw appError("ALREADY_INITIALIZED", "站点已经初始化，请直接登录", 409);
    if (!getKv(env)) throw appError("KV_NOT_BOUND", "未绑定 KV 存储，无法保存配置", 503);
    if (env.SETUP_TOKEN && String(body.setupToken || "") !== String(env.SETUP_TOKEN)) {
      throw appError("BAD_SETUP_TOKEN", "初始化口令不正确", 403);
    }
    validatePassword(body.password);

    const base = await loadConfig(env);
    const config = mergeConfig(defaultConfig(), {
      check: body.check,
      public: body.public,
      display: { siteName: body.siteName },
    });
    config.instances = applyInstancePatch(base.instances, Array.isArray(body.instances) ? body.instances : []);
    await saveConfig(env, config);

    const auth = await createAuthRecord(body.password);
    await saveAuth(env, auth);
    return ok({ initialized: true }, { "Set-Cookie": await issueSession(env, auth, request) });
  },

  async "POST /api/login"({ request, env, body, session }) {
    if (!session.initialized) throw appError("NOT_INITIALIZED", "站点尚未初始化", 409);
    const bucket = `login:${clientIp(request)}`;
    const valid = await verifyPassword(env, session.auth, body.password);
    if (!valid) {
      const { limited } = await hitRateLimit(env, bucket, 8, 600);
      if (limited) throw appError("RATE_LIMITED", "尝试次数过多，请 10 分钟后再试", 429);
      throw appError("AUTH_FAILED", "密码错误", 401);
    }
    return ok({ admin: true }, { "Set-Cookie": await issueSession(env, session.auth, request) });
  },

  "POST /api/logout": () => ok({ admin: false }, { "Set-Cookie": clearSessionCookie() }),

  async "POST /api/password"({ request, env, body, session }) {
    requireAdmin(session);
    if (String(env.ADMIN_PASSWORD || "").trim()) {
      throw appError("PASSWORD_FROM_ENV", "密码由环境变量 ADMIN_PASSWORD 管理，请在 Cloudflare 后台修改", 400);
    }
    if (!(await verifyPassword(env, session.auth, body.current))) throw appError("AUTH_FAILED", "当前密码不正确", 401);
    const auth = await createAuthRecord(body.next);
    await saveAuth(env, auth);
    return ok({ changed: true }, { "Set-Cookie": await issueSession(env, auth, request) });
  },

  async "GET /api/settings"({ env, session }) {
    requireAdmin(session);
    return ok(adminSettings(await loadConfig(env)));
  },

  async "PUT /api/settings"({ env, body, session }) {
    requireAdmin(session);
    const current = await loadConfig(env);
    const next = mergeConfig(current, { check: body.check, public: body.public, display: body.display });
    next.instances = body.instances ? applyInstancePatch(current.instances, body.instances) : current.instances;
    await saveConfig(env, next);
    return ok(adminSettings(next));
  },

  async "POST /api/instances/test"({ env, body, session }) {
    // 初始化前允许测试连接，方便向导里即时校验。
    if (session.initialized) requireAdmin(session);
    else if (env.SETUP_TOKEN && String(body.setupToken || "") !== String(env.SETUP_TOKEN)) {
      throw appError("BAD_SETUP_TOKEN", "初始化口令不正确", 403);
    }
    const config = await loadConfig(env);
    const saved = body.id ? config.instances.find((item) => item.id === body.id) : null;
    const instance = normalizeInstance({
      name: body.name || "test",
      baseUrl: body.baseUrl || saved?.baseUrl,
      accessKey: String(body.accessKey || "").trim() || saved?.accessKey,
    });
    if (!instance) throw appError("BAD_INSTANCE", "请填写 CPA 地址和管理密钥", 400);
    const files = await listAuthFiles(instance, Math.min(config.check.timeoutMs, 15000));
    return ok({ files: files.length, codex: files.filter(isCodexFile).length });
  },

  async "GET /api/snapshot"({ env, session }) {
    const config = await loadConfig(env);
    requireViewer(session, config);
    return ok(buildView(await loadSnapshot(env), config, { admin: session.admin }));
  },

  async "POST /api/scan"({ env, body, session }) {
    const config = await loadConfig(env);
    requireViewer(session, config);
    if (!session.admin && !config.public.allowCheck) throw appError("CHECK_FORBIDDEN", "访客不能触发检测", 403);
    const { snapshot, plan, cached } = await scan(env, config, { instanceId: body.instanceId || "", admin: session.admin });
    return ok({ plan, cached, view: buildView(snapshot, config, { admin: session.admin }) });
  },

  async "POST /api/check"({ env, body, session }) {
    const config = await loadConfig(env);
    requireViewer(session, config);
    if (!session.admin && !config.public.allowCheck) throw appError("CHECK_FORBIDDEN", "访客不能触发检测", 403);
    const result = await checkBatch(env, config, { ...body, admin: session.admin });
    return ok({
      checked: result.checked,
      reused: result.reused,
      view: buildView(result.snapshot, config, { admin: session.admin }),
    });
  },
};
