import { appError } from "./http.js";
import { loadAuth } from "./store.js";

const COOKIE = "cpa_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Workers 的 PBKDF2 上限是 100000 次；配合登录限速，这个强度足够单管理员站点使用。
const PBKDF2_ITERATIONS = 60000;

const encoder = new TextEncoder();

export async function hashPassword(password, salt = randomHex(16), iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations },
    key,
    256,
  );
  return { hash: toHex(new Uint8Array(bits)), salt, iterations };
}

export async function createAuthRecord(password) {
  validatePassword(password);
  const hashed = await hashPassword(password);
  return { ...hashed, secret: randomHex(32), updatedAt: new Date().toISOString() };
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 6) {
    throw appError("WEAK_PASSWORD", "密码至少 6 位", 400);
  }
  if (password.length > 200) throw appError("WEAK_PASSWORD", "密码过长", 400);
}

export async function verifyPassword(env, auth, password) {
  const input = String(password || "");
  const envPassword = String(env.ADMIN_PASSWORD || "").trim();
  if (envPassword) return timingSafeEqual(input, envPassword);
  if (!auth) return false;
  const { hash } = await hashPassword(input, auth.salt, auth.iterations);
  return timingSafeEqual(hash, auth.hash);
}

export function isInitialized(env, auth) {
  return Boolean(String(env.ADMIN_PASSWORD || "").trim() || auth?.hash);
}

function sessionSecret(env, auth) {
  return auth?.secret || `env:${String(env.ADMIN_PASSWORD || "")}`;
}

export async function issueSession(env, auth, request) {
  const payload = b64url(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }));
  const signature = await sign(payload, sessionSecret(env, auth));
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export async function isAuthenticated(request, env, auth) {
  if (!isInitialized(env, auth)) return false;
  const token = readCookie(request, COOKIE);
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = await sign(payload, sessionSecret(env, auth));
  if (!timingSafeEqual(signature, expected)) return false;
  try {
    return Number(JSON.parse(fromB64url(payload)).exp) > Date.now();
  } catch {
    return false;
  }
}

export async function currentSession(request, env) {
  const auth = await loadAuth(env);
  return { auth, initialized: isInitialized(env, auth), admin: await isAuthenticated(request, env, auth) };
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

async function sign(text, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return b64urlBytes(new Uint8Array(signature));
}

function timingSafeEqual(a, b) {
  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function b64url(text) {
  return b64urlBytes(encoder.encode(text));
}

function b64urlBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromB64url(text) {
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
