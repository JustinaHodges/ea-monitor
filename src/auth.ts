const enc = new TextEncoder();

export async function sha256Hex(data: BufferSource | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return hex(hash);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return hex(sig);
}

export function hex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.length !== bb.length) {
    let acc = 0;
    for (let i = 0; i < aa.length; i++) acc |= aa[i];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export function randomSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return hex(b.buffer);
}

export async function verifyTerminalSignature(
  request: Request,
  rawBody: ArrayBuffer,
  secret: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tsHeader = request.headers.get("X-EA-Timestamp") || "";
  const sig = (request.headers.get("X-EA-Signature") || "").toLowerCase();
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, error: "missing timestamp" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > 300) return { ok: false, error: "timestamp expired" };
  if (!sig) return { ok: false, error: "missing signature" };

  const url = new URL(request.url);
  const bodyHash = await sha256Hex(rawBody);
  const canonical = `${ts}\n${request.method.toUpperCase()}\n${url.pathname}\n${bodyHash}`;
  const expect = await hmacSha256Hex(secret, canonical);
  if (!timingSafeEqual(expect, sig)) return { ok: false, error: "bad signature" };
  return { ok: true };
}

export function parseCookie(header: string | null, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

/** Cookie 与会话一致：30 天；服务端还会按访问滑动续期 */
const ADMIN_COOKIE_MAX_AGE = 30 * 24 * 3600;

export function adminCookie(sessionToken: string, secure: boolean): string {
  const flags = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_COOKIE_MAX_AGE}${secure ? "; Secure" : ""}`;
  return `ea_admin=${encodeURIComponent(sessionToken)}; ${flags}`;
}

export function clearAdminCookie(secure: boolean): string {
  return `ea_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** 从 Cookie 或 Authorization Bearer 取会话 id（不再接受 ?token=） */
export function getAdminSessionId(request: Request): string {
  const header = request.headers.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer) return bearer;
  return parseCookie(request.headers.get("Cookie"), "ea_admin");
}

/** @deprecated 使用 validateAdminSession(env, getAdminSessionId(request)) */
export function isAdmin(request: Request, adminToken: string): boolean {
  if (!adminToken) return false;
  const header = request.headers.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const cookie = parseCookie(request.headers.get("Cookie"), "ea_admin");
  // 刻意不再读取 ?token=
  return [bearer, cookie].some((v) => v && timingSafeEqual(v, adminToken));
}

/** @deprecated 同步版已废弃；请用 adminPass.validateAdminSession */
export function isAdminSession(
  _request: Request,
  _username: string,
  _password: string,
): boolean {
  return false;
}
