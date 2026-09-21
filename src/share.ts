import { liveOnline } from "./cron";
import { buildTerminalDailyPnl } from "./pnlQuery";
import { getAlertSettings } from "./settings";
import { ensureTerminalAlertColumns } from "./sqlSafe";
import { beijingDayKeyFromSec, beijingDayStartSec } from "./timeBj";
import type { Env } from "./types";
import { json, nowSec } from "./types";
import { withOpenPrices } from "./tradeEnrich";

export async function ensureShareTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY,
      terminal_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      hours INTEGER NOT NULL DEFAULT 24,
      show_calendar INTEGER NOT NULL DEFAULT 1,
      show_books INTEGER NOT NULL DEFAULT 1
    )`,
  ).run();
  try {
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_share_terminal ON share_links(terminal_id)`).run();
  } catch {
    /* ok */
  }
  for (const ddl of [
    `ALTER TABLE share_links ADD COLUMN show_calendar INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE share_links ADD COLUMN show_books INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE share_links ADD COLUMN refresh_sec INTEGER NOT NULL DEFAULT 30`,
  ] as const) {
    try {
      await env.DB.prepare(ddl).run();
    } catch {
      /* column exists */
    }
  }
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS share_viewers (
      share_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (share_id, ip)
    )`,
  ).run();
  try {
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_share_viewers_seen ON share_viewers(last_seen)`).run();
  } catch {
    /* ok */
  }
}

function clampShareRefreshSec(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 30;
  return Math.max(5, Math.min(600, n));
}

function isCloudflareEdgeIp(ip: string): boolean {
  const s = String(ip || "").trim();
  // 常见 CF 边缘段（不全，够用来丢掉“假人数”）
  if (/^162\.158\./.test(s)) return true;
  if (/^162\.159\./.test(s)) return true;
  if (/^172\.(6[4-9]|7[0-1])\./.test(s)) return true;
  if (/^141\.101\./.test(s)) return true;
  if (/^104\.1[6-9]\./.test(s) || /^104\.2[0-7]\./.test(s)) return true;
  if (/^108\.162\./.test(s)) return true;
  if (/^198\.41\./.test(s)) return true;
  if (/^197\.234\.240\./.test(s)) return true;
  if (/^188\.114\./.test(s)) return true;
  if (/^190\.93\./.test(s)) return true;
  if (/^103\.21\.244\./.test(s) || /^103\.22\.200\./.test(s) || /^103\.31\.4\./.test(s)) return true;
  return false;
}

function isIgnorableViewerIp(ip: string): boolean {
  const s = String(ip || "").trim().toLowerCase();
  if (!s || s === "unknown" || s === "null" || s === "undefined") return true;
  if (s === "127.0.0.1" || s === "::1" || s === "0.0.0.0") return true;
  if (s.startsWith("10.") || s.startsWith("192.168.") || s.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(s)) return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80:")) return true;
  if (s === "185.93.71.252") return true;
  if (isCloudflareEdgeIp(s)) return true;
  return false;
}

function clientIpFromRequest(request?: Request): string {
  if (!request) return "";
  // Cloudflare 站前：真实访客在 CF-Connecting-IP
  const cf = (request.headers.get("cf-connecting-ip") || "").trim();
  if (cf && !isIgnorableViewerIp(cf)) return cf.slice(0, 64);
  // XFF：从左到右找第一个非代理/非 CF 的公网 IP
  const xffRaw = request.headers.get("x-forwarded-for") || "";
  for (const part of xffRaw.split(",")) {
    const ip = part.trim();
    if (ip && !isIgnorableViewerIp(ip)) return ip.slice(0, 64);
  }
  const real = (request.headers.get("x-real-ip") || "").trim();
  if (real && !isIgnorableViewerIp(real)) return real.slice(0, 64);
  // 最后兜底：即使像边缘 IP，也别完全丢掉（无更好来源时）
  if (cf) return cf.slice(0, 64);
  if (real) return real.slice(0, 64);
  return "";
}

/** 每条分享链接各自统计：同一 IP 在该链接下算 1 人 */
async function touchShareViewer(env: Env, shareId: string, request: Request | undefined, _refreshSec: number): Promise<number> {
  const ts = nowSec();
  const ip = clientIpFromRequest(request);
  // 固定 60 秒活跃窗：离开约 1 分钟后从该链接人数里消失（与心跳间隔无关）
  const windowSec = 60;
  if (ip && !isIgnorableViewerIp(ip)) {
    await env.DB.prepare(
      `INSERT INTO share_viewers (share_id, ip, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(share_id, ip) DO UPDATE SET last_seen = excluded.last_seen`,
    )
      .bind(shareId, ip, ts)
      .run();
  }
  if (ts % 30 < 2) {
    await env.DB.prepare(`DELETE FROM share_viewers WHERE last_seen < ?`).bind(ts - 600).run();
  }
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM share_viewers WHERE share_id = ? AND last_seen >= ?`,
  )
    .bind(shareId, ts - windowSec)
    .first<{ n: number }>();
  return Math.max(0, Number(row?.n || 0));
}

function shareToken(): string {
  // 8 位即可，链接更短；碰撞概率极低，创建时再兜底重试
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export type CreateShareOpts = {
  hours?: number;
  show_calendar?: boolean;
  show_books?: boolean;
  refresh_sec?: number;
};

export async function createShare(
  env: Env,
  terminalId: string,
  opts: CreateShareOpts | number = {},
): Promise<Response> {
  await ensureShareTable(env);
  const exists = await env.DB.prepare(`SELECT terminal_id, name, note FROM terminals WHERE terminal_id = ?`)
    .bind(terminalId)
    .first<{ terminal_id: string }>();
  if (!exists) return json({ error: "not found" }, 404);

  const options: CreateShareOpts = typeof opts === "number" ? { hours: opts } : opts || {};
  const hours = Math.max(1, Math.min(24 * 90, Math.floor(Number(options.hours) || 24)));
  const showCalendar = options.show_calendar === false ? 0 : 1;
  const showBooks = options.show_books === false ? 0 : 1;
  const refreshSec = clampShareRefreshSec(options.refresh_sec);
  const ts = nowSec();

  let id = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = shareToken();
    const clash = await env.DB.prepare(`SELECT id FROM share_links WHERE id = ?`).bind(candidate).first();
    if (!clash) {
      id = candidate;
      break;
    }
  }
  if (!id) return json({ error: "生成链接失败，请重试" }, 500);

  await env.DB.prepare(
    `INSERT INTO share_links (id, terminal_id, created_at, expires_at, active, hours, show_calendar, show_books, refresh_sec)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  )
    .bind(id, terminalId, ts, ts + hours * 3600, hours, showCalendar, showBooks, refreshSec)
    .run();

  return json({
    ok: true,
    id,
    terminal_id: terminalId,
    hours,
    show_calendar: !!showCalendar,
    show_books: !!showBooks,
    refresh_sec: refreshSec,
    created_at: ts,
    expires_at: ts + hours * 3600,
    path: `/s/${id}`,
  });
}

export async function listShares(env: Env, terminalId: string): Promise<Response> {
  await ensureShareTable(env);
  const ts = nowSec();
  const rows = await env.DB.prepare(
    `SELECT id, terminal_id, created_at, expires_at, active, hours,
            COALESCE(show_calendar, 1) AS show_calendar,
            COALESCE(show_books, 1) AS show_books,
            COALESCE(refresh_sec, 30) AS refresh_sec
     FROM share_links WHERE terminal_id = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(terminalId)
    .all<{
      id: string;
      terminal_id: string;
      created_at: number;
      expires_at: number;
      active: number;
      hours: number;
      show_calendar: number;
      show_books: number;
      refresh_sec: number;
    }>();

  return json({
    rows: (rows.results || []).map((r) => ({
      ...r,
      active: !!r.active,
      show_calendar: !!r.show_calendar,
      show_books: !!r.show_books,
      refresh_sec: clampShareRefreshSec(r.refresh_sec),
      expired: r.expires_at <= ts,
      alive: !!r.active && r.expires_at > ts,
      path: `/s/${r.id}`,
    })),
  });
}

export async function stopShare(env: Env, id: string): Promise<Response> {
  await ensureShareTable(env);
  const res = await env.DB.prepare(`UPDATE share_links SET active = 0 WHERE id = ?`).bind(id).run();
  if (!res.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true, id, active: false });
}

/** 每次延长 3 小时（上限 2160）；已过期则从当前时间起算 */
export async function extendShare(env: Env, id: string, addHours = 3): Promise<Response> {
  await ensureShareTable(env);
  const ts = nowSec();
  const add = Math.max(1, Math.min(72, Math.floor(Number(addHours) || 3)));
  const row = await env.DB.prepare(
    `SELECT id, created_at, expires_at, active, hours FROM share_links WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; created_at: number; expires_at: number; active: number; hours: number }>();
  if (!row) return json({ error: "not found" }, 404);
  if (!row.active) return json({ error: "已停止的链接不能延长，请重新生成" }, 400);

  const nextHours = Math.min(2160, Number(row.hours || 0) + add);
  const base = Math.max(Number(row.expires_at || 0), ts);
  const nextExp = base + add * 3600;

  await env.DB.prepare(`UPDATE share_links SET hours = ?, expires_at = ? WHERE id = ?`)
    .bind(nextHours, nextExp, id)
    .run();

  return json({
    ok: true,
    id,
    hours: nextHours,
    expires_at: nextExp,
    added_hours: add,
  });
}

export async function deleteShare(env: Env, id: string): Promise<Response> {
  await ensureShareTable(env);
  const res = await env.DB.prepare(`DELETE FROM share_links WHERE id = ?`).bind(id).run();
  if (!res.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true, id });
}

export async function deleteSharesForTerminal(env: Env, terminalId: string): Promise<void> {
  await ensureShareTable(env);
  await env.DB.prepare(`DELETE FROM share_links WHERE terminal_id = ?`).bind(terminalId).run();
}

/** 公开报表：首页实例卡 + 与站内同步的月报日历 */

type ShareLinkRow = {
  id: string;
  terminal_id: string;
  created_at: number;
  expires_at: number;
  active: number;
  hours: number;
  show_calendar: number;
  show_books: number;
  refresh_sec: number;
};

async function loadActiveShareLink(
  env: Env,
  id: string,
): Promise<{ link: ShareLinkRow } | { error: Response }> {
  await ensureShareTable(env);
  const ts = nowSec();
  const link = await env.DB.prepare(
    `SELECT id, terminal_id, created_at, expires_at, active, hours,
            COALESCE(show_calendar, 1) AS show_calendar,
            COALESCE(show_books, 1) AS show_books,
            COALESCE(refresh_sec, 30) AS refresh_sec
     FROM share_links WHERE id = ?`,
  )
    .bind(id)
    .first<ShareLinkRow>();

  if (!link) return { error: json({ error: "链接不存在或已删除" }, 404) };
  if (!link.active) return { error: json({ error: "分享已停止" }, 410) };
  if (link.expires_at <= ts) return { error: json({ error: "分享链接已过期" }, 410) };
  return { link };
}

/** 分享页点日历：按日查该实例成交（无需登录，仅限有效分享 token） */
export async function getPublicShareTrades(env: Env, id: string, url: URL): Promise<Response> {
  const loaded = await loadActiveShareLink(env, id);
  if ("error" in loaded) return loaded.error;
  const { link } = loaded;
  if (!Number(link.show_calendar)) {
    return json({ error: "此分享未开放成交明细" }, 403);
  }

  const from = Number(url.searchParams.get("from") || nowSec() - 86400);
  const to = Number(url.searchParams.get("to") || nowSec());
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return json({ error: "无效的时间范围" }, 400);
  }
  // 单日窗口，防止一次拖走全库
  if (to - from > 2 * 86400) {
    return json({ error: "时间范围过大" }, 400);
  }
  const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") || 300)));

  const raw = await env.DB.prepare(
    `SELECT ts, ticket, symbol, side, entry, volume, price, profit, commission, swap, comment
     FROM trades
     WHERE terminal_id = ? AND ts >= ? AND ts <= ?
     ORDER BY ts DESC LIMIT ?`,
  )
    .bind(link.terminal_id, from, to, limit)
    .all();
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM trades WHERE terminal_id = ? AND ts >= ? AND ts <= ?`,
  )
    .bind(link.terminal_id, from, to)
    .first<{ c: number }>();
  const termMeta = await env.DB.prepare(
    `SELECT COALESCE(broker_gmt_offset, 0) AS broker_gmt_offset,
            COALESCE(quote_digits, 2) AS quote_digits
     FROM terminals WHERE terminal_id = ?`,
  )
    .bind(link.terminal_id)
    .first<{ broker_gmt_offset: number; quote_digits: number }>();

  const rows = await withOpenPrices(env, (raw.results || []) as Record<string, unknown>[], link.terminal_id);

  return json({
    rows,
    total: Number(count?.c || 0),
    limit,
    broker_gmt_offset: Number(termMeta?.broker_gmt_offset || 0),
    quote_digits: Number(termMeta?.quote_digits || 2),
  });
}

export async function getPublicShare(env: Env, id: string, request?: Request): Promise<Response> {
  await ensureTerminalAlertColumns(env);
  const loaded = await loadActiveShareLink(env, id);
  if ("error" in loaded) return loaded.error;
  const link = loaded.link;
  const ts = nowSec();
  const refreshSec = clampShareRefreshSec(link.refresh_sec);
  const viewers = await touchShareViewer(env, link.id, request, refreshSec);

  const term = await env.DB.prepare(
    `SELECT terminal_id, name, note, group_id, platform, online, last_seen, last_error,
            COALESCE(display_unit, '') AS display_unit,
            COALESCE(share_intro, '') AS share_intro,
            COALESCE(share_contact, '') AS share_contact,
            COALESCE(quote_digits, 2) AS quote_digits,
            COALESCE(leverage, 0) AS leverage,
            COALESCE(min_floating_pl, 0) AS min_floating_pl,
            COALESCE(today_min_floating_pl, 0) AS today_min_floating_pl,
            COALESCE(today_min_day, 0) AS today_min_day,
            COALESCE(float_profit_latched, 0) AS float_profit_latched,
            COALESCE(float_loss_latched, 0) AS float_loss_latched
     FROM terminals WHERE terminal_id = ?`,
  )
    .bind(link.terminal_id)
    .first<{
      terminal_id: string;
      name: string;
      note: string;
      group_id: string;
      platform: string;
      online: number;
      last_seen: number;
      last_error: string;
      display_unit: string;
      share_intro: string;
      share_contact: string;
      quote_digits: number;
      leverage: number;
      min_floating_pl: number;
      today_min_floating_pl: number;
      today_min_day: number;
      float_profit_latched: number;
      float_loss_latched: number;
    }>();
  if (!term) return json({ error: "实例已删除" }, 404);

  const settings = await getAlertSettings(env);
  const on = liveOnline(term.last_seen || 0, settings.offline_after_seconds, ts);
  const gid = term.group_id || "default";
  const group = await env.DB.prepare(`SELECT name FROM groups WHERE id = ?`)
    .bind(gid)
    .first<{ name: string }>();

  const ea = await env.DB.prepare(
    `SELECT balance, equity, floating_pl, position_count
     FROM eas WHERE terminal_id = ? ORDER BY last_heartbeat DESC LIMIT 1`,
  )
    .bind(link.terminal_id)
    .first<{ balance: number; equity: number; floating_pl: number; position_count: number }>();

  const lots = await env.DB.prepare(
    `SELECT COALESCE(SUM(volume),0) AS lots,
            COUNT(*) AS cnt,
            COALESCE(SUM(profit),0) AS floating,
            COALESCE(MAX(COALESCE(spread,0)),0) AS spread
     FROM positions_latest WHERE terminal_id = ? AND kind = 'position'`,
  )
    .bind(link.terminal_id)
    .first<{ lots: number; cnt: number; floating: number; spread: number }>();

  // 与首页卡片同一套日切（北京自然日），保证分享卡数字和首页一致
  const dayStart = beijingDayStartSec(ts);
  const yDayStart = dayStart - 86400;
  const today = await env.DB.prepare(
    `SELECT COALESCE(SUM(profit + commission + swap),0) AS pnl FROM trades
     WHERE terminal_id = ? AND ts >= ?`,
  )
    .bind(link.terminal_id, dayStart)
    .first<{ pnl: number }>();
  const yesterday = await env.DB.prepare(
    `SELECT COALESCE(SUM(profit + commission + swap),0) AS pnl FROM trades
     WHERE terminal_id = ? AND ts >= ? AND ts < ?`,
  )
    .bind(link.terminal_id, yDayStart, dayStart)
    .first<{ pnl: number }>();

  const closes = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt,
            COALESCE(SUM(profit + commission + swap), 0) AS pnl,
            MAX(ts) AS last_ts
     FROM trades
     WHERE terminal_id = ? AND ts >= ?
       AND (entry = 'out' OR entry = 'inout' OR entry = '' OR entry IS NULL)`,
  )
    .bind(link.terminal_id, dayStart)
    .first<{ cnt: number; pnl: number; last_ts: number | null }>();

  const maxDd = await env.DB.prepare(
    `SELECT MIN(floating_pl) AS hist_mn,
            MIN(CASE WHEN ts >= ? THEN floating_pl END) AS today_mn
     FROM snapshots WHERE terminal_id = ?`,
  )
    .bind(dayStart, link.terminal_id)
    .first<{ hist_mn: number | null; today_mn: number | null }>();

  const posCnt = Number(lots?.cnt ?? 0);
  const floating = posCnt === 0 ? 0 : Number(lots?.floating ?? 0);
  const histMin = maxDd?.hist_mn != null ? Number(maxDd.hist_mn) : floating;
  const todayMin = maxDd?.today_mn != null ? Number(maxDd.today_mn) : floating;
  const eaAllMin = Number(term.min_floating_pl || 0);
  const eaTodayMin = Number(term.today_min_day || 0) === dayStart
    ? Number(term.today_min_floating_pl || 0)
    : floating;
  const maxFloatLoss = Math.abs(Math.min(0, histMin, eaAllMin, floating));
  const todayMaxFloatLoss = Math.abs(Math.min(0, todayMin, eaTodayMin, floating));
  const safe = !term.last_error && on && floating > -Math.max(500, maxFloatLoss * 2);
  const alerting =
    (settings.alert_float_profit !== false && Number(term.float_profit_latched || 0) === 1) ||
    (settings.alert_float_loss !== false && Number(term.float_loss_latched || 0) === 1);

  const card = {
    name: term.name || term.note || term.terminal_id,
    note: term.note || term.name || "",
    group_name: group?.name || "默认分组",
    platform: term.platform || "",
    display_unit: String(term.display_unit || "").trim(),
    quote_digits: Number(term.quote_digits || 2),
    leverage: Number(term.leverage || 0),
    online: on,
    viewers,
    last_seen: term.last_seen || 0,
    lots: Number(lots?.lots ?? 0),
    position_count: posCnt,
    floating_pl: floating,
    equity: Number(ea?.equity ?? 0),
    balance: Number(ea?.balance ?? 0),
    today_pnl: Number(today?.pnl || 0),
    yesterday_pnl: Number(yesterday?.pnl || 0),
    close_count: Number(closes?.cnt || 0),
    last_close_pnl: Number(closes?.pnl || 0),
    last_close_ts: Number(closes?.last_ts || 0),
    today_max_float_loss: todayMaxFloatLoss,
    max_float_loss: maxFloatLoss,
    spread: posCnt === 0 ? 0 : Number(lots?.spread ?? 0),
    safe,
    alerting,
  };

  // 与管理端 /api/v1/pnl 同一窗口，避免两边日历时间范围不一致
  // show_books：仅控制是否开放挂单明细；持仓始终返回
  const allowDayTrades = !!Number(link.show_calendar);
  const showPending = !!Number(link.show_books);
  const from = ts - 730 * 86400;
  const to = ts + 14 * 86400;
  const { daily: cumulative, total_pnl } = await buildTerminalDailyPnl(env, link.terminal_id, from, to);
  const todayKey = beijingDayKeyFromSec(ts);
  const monthKeyStr = todayKey.slice(0, 7);
  const monthPnl = cumulative.filter((d) => d.day.startsWith(monthKeyStr)).reduce((a, b) => a + b.pnl, 0);
  const monthTrades = cumulative.filter((d) => d.day.startsWith(monthKeyStr)).reduce((a, b) => a + b.trades, 0);

  const posAll = await env.DB.prepare(
    `SELECT ticket, symbol, kind, side, volume, price_open, price_current, sl, tp, profit, magic, comment, open_time
     FROM positions_latest WHERE terminal_id = ?
     ORDER BY kind, symbol, ticket LIMIT 300`,
  )
    .bind(link.terminal_id)
    .all<{
      ticket: string;
      symbol: string;
      kind: string;
      side: string;
      volume: number;
      price_open: number;
      price_current: number;
      sl: number;
      tp: number;
      profit: number;
      magic: number;
      comment: string;
      open_time: number;
    }>();
  const positions = (posAll.results || []).filter((r) => r.kind === "position").map(mapSharePosRow);
  const pending = showPending
    ? (posAll.results || []).filter((r) => r.kind === "pending").map(mapSharePosRow)
    : [];

  return json({
    ok: true,
    expires_at: link.expires_at,
    hours: link.hours,
    show_calendar: allowDayTrades,
    show_day_trades: allowDayTrades,
    show_books: showPending,
    show_pending: showPending,
    refresh_sec: refreshSec,
    viewers,
    share_intro: String(term.share_intro || "").trim(),
    share_contact: String(term.share_contact || "").trim(),
    instance: {
      name: card.name,
      note: card.note,
      platform: card.platform,
      group_name: card.group_name,
    },
    card,
    summary: {
      balance: card.balance,
      equity: card.equity,
      floating_pl: card.floating_pl,
      today_pnl: card.today_pnl,
      month_pnl: monthPnl,
      month_trades: monthTrades,
      period_pnl: total_pnl,
    },
    positions,
    pending,
    daily: cumulative,
    month: monthKeyStr,
  });
}

function mapSharePosRow(r: {
  ticket: string;
  symbol: string;
  kind: string;
  side: string;
  volume: number;
  price_open: number;
  price_current: number;
  sl: number;
  tp: number;
  profit: number;
  magic: number;
  comment: string;
  open_time: number;
}) {
  return {
    symbol: r.symbol || "",
    side: r.side || "",
    volume: Number(r.volume || 0),
    price_open: Number(r.price_open || 0),
    price_current: Number(r.price_current || 0),
    sl: Number(r.sl || 0),
    tp: Number(r.tp || 0),
    profit: Number(r.profit || 0),
    magic: Number(r.magic || 0),
    comment: r.comment || "",
    open_time: Number(r.open_time || 0),
  };
}
