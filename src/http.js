export class AppError extends Error {
  constructor(code, message, status = 500, detail = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function appError(code, message, status = 500, detail = null) {
  return new AppError(code, message, status, detail);
}

export function normalizeError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, status: error.status, detail: error.detail };
  }
  if (error && error.name === "AbortError") {
    return { code: "TIMEOUT", message: "请求超时", status: 504, detail: null };
  }
  return {
    code: "INTERNAL_ERROR",
    message: (error && error.message) || "未知错误",
    status: 500,
    detail: null,
  };
}

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function ok(data, headers = {}) {
  return json({ ok: true, data, error: null }, 200, headers);
}

export function fail(error) {
  const normalized = normalizeError(error);
  return json({ ok: false, data: null, error: normalized }, normalized.status || 500);
}

export async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const contentType = request.headers.get("Content-Type") || "";
  // 只接受 JSON，配合 SameSite cookie 防止跨站表单提交。
  if (!contentType.toLowerCase().includes("application/json")) {
    throw appError("BAD_CONTENT_TYPE", "请求必须是 application/json", 415);
  }
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw appError("BAD_JSON", "请求体不是有效 JSON", 400);
  }
}

export function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}
