import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import worker from "../src/index.js";
import { extractQuotaBars } from "../src/cpa.js";

class MemoryKV {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
}

const ACCESS_KEY = "mgmt-secret";
const files = [
  { id: "codex-alice.json", provider: "codex", auth_index: "1", id_token: { chatgpt_account_id: "acct-1111" }, email: "alice@example.com" },
  { id: "codex-bob.json", provider: "codex", auth_index: "2", id_token: { chatgpt_account_id: "acct-2222" } },
  { id: "codex-off.json", provider: "codex", auth_index: "3", disabled: true },
  { id: "gemini-x.json", provider: "gemini", auth_index: "4" },
];

let cpa;
let cpaUrl;

before(async () => {
  cpa = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${ACCESS_KEY}`) {
      res.writeHead(401).end("{}");
      return;
    }
    if (req.url === "/v0/management/auth-files") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ files }));
      return;
    }
    if (req.url === "/v0/management/api-call") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const reply =
        body.authIndex === "2"
          ? { status_code: 401, body: "{}" }
          : {
              status_code: 200,
              body: JSON.stringify({
                plan_type: "plus",
                rate_limit: {
                  primary_window: { used_percent: 25, reset_after_seconds: 3600 },
                  secondary_window: { used_percent: 60, reset_at: 1893456000 },
                },
              }),
            };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => cpa.listen(0, "127.0.0.1", resolve));
  cpaUrl = `http://127.0.0.1:${cpa.address().port}`;
});

after(() => cpa.close());

function client(env) {
  let cookie = "";
  return async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    const response = await worker.fetch(
      new Request(`https://monitor.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      { waitUntil() {} },
    );
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, json: await response.json() };
  };
}

test("setup → scan → batched check → public masking", async () => {
  const env = { CPA_MONITOR_KV: new MemoryKV() };
  const admin = client(env);

  let res = await admin("GET", "/api/bootstrap");
  assert.equal(res.json.data.initialized, false);

  res = await admin("POST", "/api/instances/test", { baseUrl: cpaUrl, accessKey: ACCESS_KEY });
  assert.equal(res.json.data.codex, 3);

  res = await admin("POST", "/api/instances/test", { baseUrl: cpaUrl, accessKey: "wrong" });
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, "CPA_AUTH_FAILED");

  res = await admin("POST", "/api/setup", {
    password: "hunter22",
    siteName: "测试站",
    instances: [{ name: "Main", baseUrl: `${cpaUrl}/`, accessKey: ACCESS_KEY }],
    public: { privacyMode: true },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  res = await admin("POST", "/api/setup", { password: "another1" });
  assert.equal(res.status, 409);

  res = await admin("GET", "/api/settings");
  assert.equal(res.json.data.instances[0].accessKey, undefined);
  assert.equal(res.json.data.instances[0].accessKeyHint, "••••cret");
  const instanceId = res.json.data.instances[0].id;

  res = await admin("POST", "/api/scan", {});
  assert.deepEqual(res.json.data.plan, [{ instanceId, total: 2 }]);
  assert.equal(res.json.data.view.summary.total, 3);

  res = await admin("POST", "/api/check", { instanceId, offset: 0, limit: 40 });
  assert.equal(res.json.data.checked, 2);
  const summary = res.json.data.view.summary;
  assert.equal(summary.ok, 1);
  assert.equal(summary.invalid401, 1);
  const alice = res.json.data.view.instances[0].files.find((file) => file.id === "codex-alice.json");
  assert.equal(alice.check.quotaBars.length, 2);
  assert.equal(alice.check.plan, "plus");

  // 访客：拿到脱敏数据，缓存期内不会重复请求 CPA。
  const guest = client(env);
  res = await guest("GET", "/api/snapshot");
  const guestFiles = res.json.data.instances[0].files;
  assert.ok(guestFiles.every((file) => !file.id.includes("alice") && !file.id.includes("bob")));
  assert.equal(res.json.data.instances[0].host, null);
  assert.ok(!JSON.stringify(res.json.data).includes("alice@example.com"));

  res = await guest("POST", "/api/check", { instanceId, offset: 0 });
  assert.equal(res.json.data.checked, 0);
  assert.equal(res.json.data.reused, 2);

  res = await guest("GET", "/api/settings");
  assert.equal(res.status, 401);

  // 更新设置时 accessKey 留空保持原值。
  res = await admin("PUT", "/api/settings", {
    instances: [{ id: instanceId, name: "Renamed", baseUrl: cpaUrl, accessKey: "" }],
    public: { access: "private" },
  });
  assert.equal(res.json.data.instances[0].name, "Renamed");
  res = await admin("POST", "/api/instances/test", { id: instanceId });
  assert.equal(res.json.data.files, 4);

  res = await guest("GET", "/api/snapshot");
  assert.equal(res.status, 401);

  // 登录 / 改密码
  const other = client(env);
  res = await other("POST", "/api/login", { password: "nope" });
  assert.equal(res.status, 401);
  res = await other("POST", "/api/login", { password: "hunter22" });
  assert.equal(res.status, 200);
  res = await other("POST", "/api/password", { current: "hunter22", next: "newpass99" });
  assert.equal(res.status, 200);
  res = await admin("GET", "/api/settings");
  assert.equal(res.status, 401, "旧会话在改密码后失效");
});

test("rejects non-JSON POST bodies", async () => {
  const env = { CPA_MONITOR_KV: new MemoryKV() };
  const response = await worker.fetch(
    new Request("https://monitor.test/api/login", { method: "POST", body: "password=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } }),
    env,
    {},
  );
  assert.equal(response.status, 415);
});

test("scheduled check respects interval", async () => {
  const env = { CPA_MONITOR_KV: new MemoryKV() };
  const admin = client(env);
  await admin("POST", "/api/setup", {
    password: "hunter22",
    instances: [{ name: "Main", baseUrl: cpaUrl, accessKey: ACCESS_KEY }],
    check: { autoCheckMinutes: 30 },
  });
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  const res = await admin("GET", "/api/snapshot");
  assert.equal(res.json.data.summary.checked, 2);
});

test("worker entry only exports the default handler", async () => {
  // Workers 运行时会拒绝入口模块里的其他具名导出。
  assert.deepEqual(Object.keys(await import("../src/index.js")), ["default"]);
});

test("quota parser", () => {
  const bars = extractQuotaBars({ rate_limit: { primary_window: { used_percent: 10 }, secondary_window: { used: 3, limit: 4 } } });
  assert.deepEqual(
    bars.map((bar) => [bar.label, bar.percent]),
    [
      ["5 小时限额", 10],
      ["周限额", 75],
    ],
  );
});
