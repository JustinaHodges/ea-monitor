import { hmacSha256Hex, timingSafeEqual } from "./auth";
import type { Env } from "./types";
import { nowSec } from "./types";

export type LicensePayload = {
  /** 绑定域名，不含协议/端口，小写 */
  domain: string;
  /** 到期 unix 秒；0 = 永久 */
  exp: number;
  /** 签发时间 */
  iat: number;
  /** 备注 */
  note?: string;
};

export type LicenseStatus = {
  enforce: boolean;
  ok: boolean;
  reason?: string;
  /** 安装包绑定域名（LICENSE_DOMAIN） */
  bound?: string;
  domain?: string;
  exp?: number;
  note?: string;
  host?: string;
};

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function normalizeDomain(raw: string): string {
  let s = String(raw || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.split("/")[0] || "";
  s = s.split(":")[0] || ""; // drop port
  if (s.startsWith("www.")) s = s.slice(4);
  return s;
}

export function hostFromRequest(request: Request): string {
  const xf = request.headers.get("x-forwarded-host");
  const host = (xf || request.headers.get("host") || "").split(",")[0].trim();
  return normalizeDomain(host);
}

export function licenseEnforce(env: Env): boolean {
  const v = String(env.LICENSE_ENFORCE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export async function signLicense(secret: string, payload: LicensePayload): Promise<string> {
  const body = JSON.stringify({
    domain: normalizeDomain(payload.domain),
    exp: Number(payload.exp) || 0,
    iat: Number(payload.iat) || nowSec(),
    note: payload.note || "",
  });
  const sig = await hmacSha256Hex(secret, body);
  return `${b64urlEncode(body)}.${sig}`;
}

export async function parseAndVerifyLicense(
  secret: string,
  licenseKey: string,
): Promise<{ ok: true; payload: LicensePayload } | { ok: false; error: string }> {
  const raw = String(licenseKey || "").trim().replace(/\s+/g, "");
  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false, error: "授权码格式错误" };
  const [bodyB64, sig] = parts;
  let body: string;
  try {
    body = b64urlDecode(bodyB64);
  } catch {
    return { ok: false, error: "授权码无法解析" };
  }
  const expect = await hmacSha256Hex(secret, body);
  if (!timingSafeEqual(expect.toLowerCase(), String(sig || "").toLowerCase())) {
    return { ok: false, error: "授权码无效（签名错误）" };
  }
  let parsed: LicensePayload;
  try {
    parsed = JSON.parse(body) as LicensePayload;
  } catch {
    return { ok: false, error: "授权码内容损坏" };
  }
  const domain = normalizeDomain(parsed.domain || "");
  if (!domain) return { ok: false, error: "授权码未绑定域名" };
  return {
    ok: true,
    payload: {
      domain,
      exp: Number(parsed.exp) || 0,
      iat: Number(parsed.iat) || 0,
      note: String(parsed.note || ""),
    },
  };
}

export async function getStoredLicenseKey(env: Env): Promise<string> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`)
      .bind("license")
      .first<{ value: string }>();
    return String(row?.value || "").trim();
  } catch {
    return "";
  }
}

export async function saveLicenseKey(env: Env, key: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind("license", key.trim(), nowSec())
    .run();
}

export async function clearLicenseKey(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind("license").run();
}

/** 校验：1) 访问域名必须等于包内绑定域名 2) 已激活且未过期的授权码 */
export async function checkLicense(env: Env, request: Request): Promise<LicenseStatus> {
  const host = hostFromRequest(request);
  const enforce = licenseEnforce(env);
  const bound = normalizeDomain(String(env.LICENSE_DOMAIN || ""));
  if (!enforce) {
    return { enforce: false, ok: true, reason: "未开启授权校验", host, bound: bound || undefined };
  }

  // 第一道：安装包绑定域名
  if (bound) {
    if (!host) {
      return { enforce: true, ok: false, reason: "无法识别访问域名", host, bound };
    }
    if (host !== bound && host !== "localhost") {
      return {
        enforce: true,
        ok: false,
        reason: `本安装包仅绑定域名 ${bound}，当前访问 ${host}，无法使用`,
        host,
        bound,
      };
    }
  }

  const secret = String(env.LICENSE_SECRET || "").trim();
  if (!secret) {
    return { enforce: true, ok: false, reason: "服务器未配置 LICENSE_SECRET", host, bound: bound || undefined };
  }

  // 第二道：必须激活授权码
  const key = await getStoredLicenseKey(env);
  if (!key) {
    return { enforce: true, ok: false, reason: "尚未激活授权", host, bound: bound || undefined };
  }
  const verified = await parseAndVerifyLicense(secret, key);
  if (!verified.ok) {
    return { enforce: true, ok: false, reason: verified.error, host, bound: bound || undefined };
  }
  const { payload } = verified;

  if (bound && payload.domain !== bound && payload.domain !== "localhost") {
    return {
      enforce: true,
      ok: false,
      reason: `授权码域名与安装包不符（授权: ${payload.domain}，安装包: ${bound}）`,
      domain: payload.domain,
      exp: payload.exp,
      note: payload.note,
      host,
      bound,
    };
  }
  if (payload.domain !== host && payload.domain !== "localhost") {
    return {
      enforce: true,
      ok: false,
      reason: `授权域名不匹配（授权: ${payload.domain}，当前: ${host || "-"}）`,
      domain: payload.domain,
      exp: payload.exp,
      note: payload.note,
      host,
      bound: bound || undefined,
    };
  }
  if (payload.exp > 0 && payload.exp < nowSec()) {
    return {
      enforce: true,
      ok: false,
      reason: "授权已过期",
      domain: payload.domain,
      exp: payload.exp,
      note: payload.note,
      host,
      bound: bound || undefined,
    };
  }
  return {
    enforce: true,
    ok: true,
    domain: payload.domain,
    exp: payload.exp,
    note: payload.note,
    host,
    bound: bound || undefined,
  };
}
