import type { Env } from "./types";

export type PromoAdSettings = {
  enabled: boolean;
  title: string;
  body: string;
  image_url: string;
  link_url: string;
  link_text: string;
  /** 弹窗联系按钮文字，如「联系我」 */
  contact_text: string;
  /** 联系方式：QQ号 / TG:@xxx / 手机 / 链接 */
  contact_value: string;
  /** 内容版本号（主站推送用） */
  rev: number;
};

const DEFAULTS: PromoAdSettings = {
  enabled: false,
  title: "",
  body: "",
  image_url: "",
  link_url: "",
  link_text: "",
  contact_text: "",
  contact_value: "",
  rev: 1,
};

/** 公益版固定从主站拉广告，不可通过环境变量关闭或改地址 */
export const PROMO_AD_SOURCE = "https://www.688118.xyz/api/v1/promo-ad";

function sanitizeUrl(raw: unknown, allowRelative = false): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.length > 2000) return "";
  if (allowRelative && /^\/(?:uploads|assets)\/[a-z0-9./_-]+$/i.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function clampText(raw: unknown, max: number): string {
  return String(raw ?? "")
    .trim()
    .slice(0, max);
}

function normalize(raw: Partial<PromoAdSettings>): PromoAdSettings {
  return {
    enabled: !!raw.enabled,
    title: clampText(raw.title, 120),
    body: clampText(raw.body, 4000),
    image_url: sanitizeUrl(raw.image_url, true),
    link_url: sanitizeUrl(raw.link_url, false),
    link_text: clampText(raw.link_text, 80) || "了解更多",
    contact_text: clampText(raw.contact_text, 40),
    contact_value: clampText(raw.contact_value, 200),
    rev: Math.max(1, Number(raw.rev) || 1),
  };
}

function absolutizeAd(ad: PromoAdSettings, origin: string): PromoAdSettings {
  const base = origin.replace(/\/$/, "");
  if (ad.image_url.startsWith("/")) {
    return { ...ad, image_url: `${base}${ad.image_url}` };
  }
  return ad;
}

/**
 * 公益版只接收广告：固定拉取主站文案，本机不可编辑、不可关闭。
 * 分享页 / 登录页均走此接口，保证弹出的是 www.688118.xyz 后台设置的广告。
 */
export async function resolvePromoAd(_env: Env): Promise<PromoAdSettings> {
  const source = PROMO_AD_SOURCE;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(source, {
      headers: { Accept: "application/json", "User-Agent": "ea-monitor-promo/1" },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return { ...DEFAULTS };
    const data = (await res.json()) as Partial<PromoAdSettings>;
    const ad = normalize(data);
    try {
      return absolutizeAd(ad, new URL(source).origin);
    } catch {
      return ad;
    }
  } catch {
    return { ...DEFAULTS };
  }
}

export function promoAdPublicJson(ad: PromoAdSettings) {
  return {
    enabled: ad.enabled,
    title: ad.title,
    body: ad.body,
    image_url: ad.image_url,
    link_url: ad.link_url,
    link_text: ad.link_text,
    contact_text: ad.contact_text,
    contact_value: ad.contact_value,
    rev: ad.rev,
  };
}
