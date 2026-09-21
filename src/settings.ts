import type { Env } from "./types";
import { nowSec } from "./types";

export type AlertSettings = {
  alert_timeout: boolean;
  alert_ea_timeout: boolean;
  alert_ea_error: boolean;
  alert_log_error: boolean;
  alert_float_profit: boolean;
  alert_float_loss: boolean;
  notify_enabled: boolean;
  /** 默认 Webhook（分组未单独配置时回退） */
  notify_webhook: string;
  /** 按分组 Webhook：group_id → url */
  notify_webhooks: Record<string, string>;
  offline_after_seconds: number;
};

const DEFAULTS: AlertSettings = {
  alert_timeout: true,
  alert_ea_timeout: true,
  alert_ea_error: true,
  alert_log_error: true,
  alert_float_profit: true,
  alert_float_loss: true,
  notify_enabled: true,
  notify_webhook: "",
  notify_webhooks: {},
  offline_after_seconds: 180,
};

function normalizeWebhooks(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(k || "").trim();
    const url = String(v ?? "").trim();
    if (!id || !url) continue;
    if (url.length > 2000) continue;
    out[id] = url;
  }
  return out;
}

export async function getAlertSettings(env: Env): Promise<AlertSettings> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`)
      .bind("alert")
      .first<{ value: string }>();
    if (!row?.value) {
      return {
        ...DEFAULTS,
        notify_webhook: env.NOTIFY_WEBHOOK || "",
        offline_after_seconds: Number(env.OFFLINE_AFTER_SECONDS || 180) || 180,
      };
    }
    const parsed = JSON.parse(row.value) as Partial<AlertSettings>;
    return {
      ...DEFAULTS,
      ...parsed,
      notify_webhook: String(parsed.notify_webhook ?? env.NOTIFY_WEBHOOK ?? ""),
      notify_webhooks: normalizeWebhooks(parsed.notify_webhooks),
      offline_after_seconds: Math.max(60, Number(parsed.offline_after_seconds || 180)),
    };
  } catch {
    return {
      ...DEFAULTS,
      notify_webhook: env.NOTIFY_WEBHOOK || "",
    };
  }
}

export async function saveAlertSettings(env: Env, patch: Partial<AlertSettings>): Promise<AlertSettings> {
  const cur = await getAlertSettings(env);
  const next: AlertSettings = {
    alert_timeout: patch.alert_timeout ?? cur.alert_timeout,
    alert_ea_timeout: patch.alert_ea_timeout ?? cur.alert_ea_timeout,
    alert_ea_error: patch.alert_ea_error ?? cur.alert_ea_error,
    alert_log_error: patch.alert_log_error ?? cur.alert_log_error,
    alert_float_profit: patch.alert_float_profit ?? cur.alert_float_profit,
    alert_float_loss: patch.alert_float_loss ?? cur.alert_float_loss,
    notify_enabled: patch.notify_enabled ?? cur.notify_enabled,
    notify_webhook: patch.notify_webhook != null ? String(patch.notify_webhook).trim() : cur.notify_webhook,
    notify_webhooks:
      patch.notify_webhooks != null ? normalizeWebhooks(patch.notify_webhooks) : cur.notify_webhooks,
    offline_after_seconds: Math.max(60, Number(patch.offline_after_seconds ?? cur.offline_after_seconds) || 180),
  };
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind("alert", JSON.stringify(next), nowSec())
    .run();
  return next;
}

export type UiSettings = {
  /** 白天 · 电脑 */
  bg_day_desktop: string;
  /** 白天 · 手机 */
  bg_day_mobile: string;
  /** 黑夜 · 电脑 */
  bg_night_desktop: string;
  /** 黑夜 · 手机 */
  bg_night_mobile: string;
};

const UI_DEFAULTS: UiSettings = {
  bg_day_desktop: "",
  bg_day_mobile: "",
  bg_night_desktop: "",
  bg_night_mobile: "",
};

function sanitizeBgUrl(raw: unknown): string {
  const s = String(raw ?? "")
    .trim()
    .split("?")[0]
    .split("#")[0];
  if (!s) return "";
  if (s.length > 2000) return "";
  // 本站上传的高清原图（允许 slot-时间戳.ext）
  if (/^\/uploads\/bg\/[a-z0-9._-]+$/i.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function normalizeUiSettings(parsed: Partial<UiSettings> & { bg_url?: string }): UiSettings {
  const legacy = sanitizeBgUrl(parsed.bg_url);
  return {
    bg_day_desktop: sanitizeBgUrl(parsed.bg_day_desktop) || legacy,
    bg_day_mobile: sanitizeBgUrl(parsed.bg_day_mobile) || legacy,
    bg_night_desktop: sanitizeBgUrl(parsed.bg_night_desktop) || legacy,
    bg_night_mobile: sanitizeBgUrl(parsed.bg_night_mobile) || legacy,
  };
}

export async function getUiSettings(env: Env): Promise<UiSettings> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`)
      .bind("ui")
      .first<{ value: string }>();
    if (!row?.value) return { ...UI_DEFAULTS };
    const parsed = JSON.parse(row.value) as Partial<UiSettings> & { bg_url?: string };
    return normalizeUiSettings(parsed);
  } catch {
    return { ...UI_DEFAULTS };
  }
}

export async function saveUiSettings(env: Env, patch: Partial<UiSettings>): Promise<UiSettings> {
  const cur = await getUiSettings(env);
  const next: UiSettings = {
    bg_day_desktop:
      patch.bg_day_desktop != null ? sanitizeBgUrl(patch.bg_day_desktop) : cur.bg_day_desktop,
    bg_day_mobile:
      patch.bg_day_mobile != null ? sanitizeBgUrl(patch.bg_day_mobile) : cur.bg_day_mobile,
    bg_night_desktop:
      patch.bg_night_desktop != null ? sanitizeBgUrl(patch.bg_night_desktop) : cur.bg_night_desktop,
    bg_night_mobile:
      patch.bg_night_mobile != null ? sanitizeBgUrl(patch.bg_night_mobile) : cur.bg_night_mobile,
  };
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind("ui", JSON.stringify(next), nowSec())
    .run();
  return next;
}

export async function resolveNotifyWebhook(
  env: Env,
  opts?: { terminalId?: string; groupId?: string },
): Promise<{ url: string; groupId: string }> {
  const s = await getAlertSettings(env);
  let groupId = String(opts?.groupId || "").trim();
  if (!groupId && opts?.terminalId) {
    const term = await env.DB.prepare(`SELECT group_id FROM terminals WHERE terminal_id = ?`)
      .bind(opts.terminalId)
      .first<{ group_id: string }>();
    groupId = String(term?.group_id || "").trim();
  }
  if (!groupId) groupId = "default";
  const byGroup = (s.notify_webhooks && s.notify_webhooks[groupId]) || "";
  const url = byGroup || s.notify_webhook || env.NOTIFY_WEBHOOK || "";
  return { url, groupId };
}

export async function sendNotify(
  env: Env,
  text: string,
  type?: string,
  opts?: { terminalId?: string; groupId?: string },
): Promise<{ ok: boolean; detail?: string }> {
  const s = await getAlertSettings(env);
  if (!s.notify_enabled) return { ok: false, detail: "未启用外部通知" };
  if (type && type !== "test") {
    if (type === "timeout" && !s.alert_timeout) return { ok: false, detail: "timeout alert off" };
    if (type === "ea_timeout" && !s.alert_ea_timeout) return { ok: false, detail: "ea_timeout alert off" };
    if (type === "ea_error" && !s.alert_ea_error) return { ok: false, detail: "ea_error alert off" };
    if (type === "log_error" && !s.alert_log_error) return { ok: false, detail: "log_error alert off" };
    if (type === "float_profit" && !s.alert_float_profit) return { ok: false, detail: "float_profit alert off" };
    if (type === "float_loss" && !s.alert_float_loss) return { ok: false, detail: "float_loss alert off" };
  }

  const { url, groupId } = await resolveNotifyWebhook(env, opts);
  if (!url) {
    return {
      ok: false,
      detail: `请先为分组「${groupId}」填写 Webhook（或填默认地址）`,
    };
  }

  const body = buildWebhookBody(url, text);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}${raw ? `: ${raw.slice(0, 180)}` : ""}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "notify failed";
    if (/network|connection|fetch failed|lost/i.test(msg)) {
      return {
        ok: false,
        detail: `${msg}（本地开发常连不上 Discord；可换企业微信/钉钉，或部署到 Cloudflare 后再测）`,
      };
    }
    return { ok: false, detail: msg };
  }
}

function buildWebhookBody(url: string, text: string): Record<string, unknown> {
  const u = url.toLowerCase();
  // Discord
  if (u.includes("discord.com/api/webhooks") || u.includes("discordapp.com/api/webhooks")) {
    return { content: text.slice(0, 1900) };
  }
  // 企业微信
  if (u.includes("qyapi.weixin.qq.com")) {
    return { msgtype: "text", text: { content: text } };
  }
  // 钉钉
  if (u.includes("oapi.dingtalk.com")) {
    return { msgtype: "text", text: { content: text } };
  }
  // 飞书
  if (u.includes("feishu.cn") || u.includes("larksuite.com")) {
    return { msg_type: "text", content: { text } };
  }
  // Bark / 通用
  return { text, content: text, message: text, msgtype: "text" };
}
