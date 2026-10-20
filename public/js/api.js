export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body, { timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok === false) {
      const error = payload?.error;
      throw new ApiError(error?.message || `HTTP ${response.status}`, response.status, error?.code || "HTTP_ERROR");
    }
    return payload.data;
  } catch (error) {
    if (error.name === "AbortError") throw new ApiError("请求超时", 504, "TIMEOUT");
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.message || "网络错误", 0, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  bootstrap: () => request("GET", "/api/bootstrap"),
  setup: (body) => request("POST", "/api/setup", body),
  login: (password) => request("POST", "/api/login", { password }),
  logout: () => request("POST", "/api/logout", {}),
  changePassword: (current, next) => request("POST", "/api/password", { current, next }),
  settings: () => request("GET", "/api/settings"),
  saveSettings: (body) => request("PUT", "/api/settings", body),
  testInstance: (body) => request("POST", "/api/instances/test", body, { timeoutMs: 20000 }),
  snapshot: () => request("GET", "/api/snapshot"),
  scan: (instanceId = "") => request("POST", "/api/scan", { instanceId }),
  check: (instanceId, offset, limit) => request("POST", "/api/check", { instanceId, offset, limit }),
};
