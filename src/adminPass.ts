import { randomSecret, timingSafeEqual } from "./auth";
import type { Env } from "./types";
import { nowSec } from "./types";

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

function fromHex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const ADMIN_PASS_KEY = "admin_password";
const ADMIN_USER_KEY = "admin_username";
const DEFAULT_USERNAME = "admin";
const PBKDF2_ITERS = 100_000;
/** 监控看板常挂着看实时数据：默认 30 天；有请求会滑动续期 */
const SESSION_TTL_SEC = 30 * 24 * 3600;
const enc = new TextEncoder();

export function adminSessionTtlSec(): number {
  return SESSION_TTL_SEC;
}

let sessionsReady = false;

async function getSetting(env: Env, key: string): Promise<string> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`)
      .bind(key)
      .first<{ value: string }>();
    return String(row?.value || "").trim();
  } catch {
    return "";
  }
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, nowSec())
    .run();
}

export async function ensureAdminSessionsTable(env: Env): Promise<void> {
  if (sessionsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS admin_sessions (
       id TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL
     )`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions(expires_at)`,
  ).run();
  sessionsReady = true;
}

function isHashedPassword(stored: string): boolean {
  return stored.startsWith("pbkdf2$");
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERS}$${toHex(salt)}$${toHex(bits)}`;
}

async function verifyAgainstStored(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if (!isHashedPassword(stored)) {
    return timingSafeEqual(String(password || ""), stored);
  }
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const saltHex = parts[2];
  const expectHex = parts[3];
  if (!Number.isFinite(iterations) || iterations < 10_000 || !saltHex || !expectHex) return false;
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return timingSafeEqual(toHex(bits), expectHex.toLowerCase());
}

/** 管理员账号：数据库优先，否则默认 admin */
export async function getAdminUsername(env: Env): Promise<string> {
  const fromDb = await getSetting(env, ADMIN_USER_KEY);
  if (fromDb) return fromDb;
  return DEFAULT_USERNAME;
}

/** 存储中的密码记录（可能是哈希或旧明文 / ADMIN_TOKEN） */
async function getStoredPasswordSecret(env: Env): Promise<string> {
  const fromDb = await getSetting(env, ADMIN_PASS_KEY);
  if (fromDb) return fromDb;
  return String(env.ADMIN_TOKEN || "").trim();
}

export async function setAdminUsername(env: Env, username: string): Promise<void> {
  const u = String(username || "").trim();
  if (u.length < 2) throw new Error("账号至少 2 个字符");
  if (u.length > 64) throw new Error("账号过长");
  if (!/^[a-zA-Z0-9_\u4e00-\u9fff.-]+$/.test(u)) {
    throw new Error("账号只能含字母、数字、下划线、点或中文");
  }
  await setSetting(env, ADMIN_USER_KEY, u);
}

export async function setAdminPassword(env: Env, password: string): Promise<void> {
  const p = String(password || "").trim();
  if (p.length < 6) throw new Error("新密码至少 6 位");
  if (p.length > 200) throw new Error("密码过长");
  await setSetting(env, ADMIN_PASS_KEY, await hashPassword(p));
}

/** 登录成功后把旧明文密码升级为哈希 */
async function upgradePasswordIfPlain(env: Env, password: string, stored: string): Promise<void> {
  if (!stored || isHashedPassword(stored)) return;
  await setSetting(env, ADMIN_PASS_KEY, await hashPassword(password));
}

export async function verifyAdminPassword(env: Env, password: string): Promise<boolean> {
  const stored = await getStoredPasswordSecret(env);
  const ok = await verifyAgainstStored(password, stored);
  if (ok) await upgradePasswordIfPlain(env, password, stored);
  return ok;
}

export async function verifyAdminLogin(
  env: Env,
  username: string,
  password: string,
): Promise<boolean> {
  const expectUser = await getAdminUsername(env);
  const stored = await getStoredPasswordSecret(env);
  if (!stored) return false;
  const uOk = timingSafeEqual(String(username || "").trim(), expectUser);
  const pOk = await verifyAgainstStored(password, stored);
  if (uOk && pOk) {
    await upgradePasswordIfPlain(env, password, stored);
    return true;
  }
  return false;
}

export async function createAdminSession(env: Env): Promise<string> {
  await ensureAdminSessionsTable(env);
  const id = randomSecret();
  const ts = nowSec();
  await env.DB.prepare(
    `INSERT INTO admin_sessions (id, created_at, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(id, ts, ts + SESSION_TTL_SEC)
    .run();
  // 顺手清过期会话
  await env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at <= ?`).bind(ts).run();
  return id;
}

export async function destroyAdminSession(env: Env, sessionId: string): Promise<void> {
  if (!sessionId) return;
  await ensureAdminSessionsTable(env);
  await env.DB.prepare(`DELETE FROM admin_sessions WHERE id = ?`).bind(sessionId).run();
}

export async function revokeAllAdminSessions(env: Env): Promise<void> {
  await ensureAdminSessionsTable(env);
  await env.DB.prepare(`DELETE FROM admin_sessions`).run();
}

export async function validateAdminSession(env: Env, sessionId: string): Promise<boolean> {
  if (!sessionId || sessionId.length < 32) return false;
  await ensureAdminSessionsTable(env);
  const ts = nowSec();
  const row = await env.DB.prepare(
    `SELECT id, expires_at FROM admin_sessions WHERE id = ? AND expires_at > ?`,
  )
    .bind(sessionId, ts)
    .first<{ id: string; expires_at: number }>();
  if (!row?.id) return false;
  // 滑动续期：有访问就把过期时间往后推，挂着看板不会掉线
  const nextExp = ts + SESSION_TTL_SEC;
  if (Number(row.expires_at || 0) < nextExp - 3600) {
    await env.DB.prepare(`UPDATE admin_sessions SET expires_at = ? WHERE id = ?`)
      .bind(nextExp, sessionId)
      .run();
  }
  return true;
}

/** @deprecated 旧 API 兼容名；请用 createAdminSession */
export function encodeAdminSession(_username: string, _password: string): string {
  throw new Error("encodeAdminSession removed — use createAdminSession");
}
