// 自托管入口：用 Node.js 运行同一份 Worker 代码（Docker / VPS 使用）。
// KV 用本地 JSON 文件模拟，静态文件直接从 public/ 读取。
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");
const dataDir = resolve(process.env.DATA_DIR || join(root, "data"));
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const trustProxy = ["1", "true", "yes"].includes(String(process.env.TRUST_PROXY || "").toLowerCase());

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

class FileKV {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.file), { recursive: true });
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(await readFile(this.file, "utf8"));
      } catch {
        console.warn(`[kv] ${this.file} 损坏，已忽略`);
      }
    }
  }

  async get(key) {
    const item = this.data[key];
    if (!item) return null;
    if (item.expiresAt && item.expiresAt < Date.now()) {
      delete this.data[key];
      return null;
    }
    return item.value;
  }

  async put(key, value, options = {}) {
    const ttl = Number(options.expirationTtl);
    this.data[key] = { value: String(value), ...(ttl > 0 ? { expiresAt: Date.now() + ttl * 1000 } : {}) };
    return this.flush();
  }

  async delete(key) {
    delete this.data[key];
    return this.flush();
  }

  flush() {
    this.queue = this.queue.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data));
      await rename(tmp, this.file);
    });
    return this.queue;
  }
}

const kv = new FileKV(join(dataDir, "kv.json"));
await kv.load();

const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    let file = join(publicDir, relative);
    if (!file.startsWith(publicDir)) return new Response("Forbidden", { status: 403 });
    if (pathname.endsWith("/")) file = join(file, "index.html");
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          "Content-Type": MIME[extname(file)] || "application/octet-stream",
          "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=300",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

const env = { ...process.env, CPA_MONITOR_KV: kv, ASSETS };
const ctx = { waitUntil: (promise) => promise.catch((error) => console.error(error)), passThroughOnException() {} };

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const protocol = trustProxy && req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
    }
    // 登录限速依赖客户端 IP：只有显式信任反向代理时才读取 X-Forwarded-For。
    const forwarded = trustProxy ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
    headers.set("CF-Connecting-IP", forwarded || req.socket.remoteAddress || "unknown");
    const request = new Request(`${protocol}://${req.headers.host || "localhost"}${req.url}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env, ctx);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal error");
  }
});

server.listen(port, host, () => {
  console.log(`CPA Monitor 已启动: http://localhost:${port}  (数据目录 ${dataDir})`);
});

// 与 Cloudflare Cron 一致：每 5 分钟唤醒一次定时检测。
setInterval(() => worker.scheduled({ cron: "*/5 * * * *" }, env, ctx), 5 * 60 * 1000).unref();
