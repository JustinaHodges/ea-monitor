import { adminCookie, clearAdminCookie, getAdminSessionId, randomSecret } from "./auth";
import {
  createAdminSession,
  destroyAdminSession,
  getAdminUsername,
  revokeAllAdminSessions,
  setAdminPassword,
  setAdminUsername,
  validateAdminSession,
  verifyAdminLogin,
  verifyAdminPassword,
} from "./adminPass";
import { assertLoginAllowed, clearLoginFailures, clientIp, recordLoginFailure } from "./loginRate";
import type { Env } from "./types";
import { json, nowSec } from "./types";
import { sampleAlertMessage } from "./alertMsg";
import { liveOnline } from "./cron";
import { getAlertSettings, saveAlertSettings, sendNotify, getUiSettings, saveUiSettings } from "./settings";
import { buildScopedDailyPnl, buildTerminalDailyPnl } from "./pnlQuery";
import { withOpenPrices } from "./tradeEnrich";
import { beijingDayStartSec, beijingMonthStartSec, SQL_BJ_DAY_S, SQL_BJ_DAY_T, SQL_BJ_MONTH_T } from "./timeBj";
import {
  checkLicense,
  clearLicenseKey,
  normalizeDomain,
  parseAndVerifyLicense,
  saveLicenseKey,
} from "./license";
import {
  createShare,
  deleteShare,
  deleteSharesForTerminal,
  extendShare,
  getPublicShare,
  getPublicShareTrades,
  listShares,
  stopShare,
} from "./share";
import { clampInt, ensureTerminalAlertColumns, finiteNumber, likeEscape } from "./sqlSafe";

function q(url: URL, key: string): string {
  return url.searchParams.get(key) || "";
}

async function requireLicense(env: Env, request: Request): Promise<Response | null> {
  const st = await checkLicense(env, request);
  if (!st.enforce || st.ok) return null;
  return json({ error: st.reason || "未授权", license: st }, 402);
}

export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // 授权状态（公开，供激活页）
  if (path === "/api/v1/license" && request.method === "GET") {
    return json(await checkLicense(env, request));
  }

  // 激活授权（公开）
  if (path === "/api/v1/license/activate" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { key?: string };
    const key = String(body.key || "").trim();
    if (!key) return json({ error: "请填写授权码" }, 400);
    const secret = String(env.LICENSE_SECRET || "").trim();
    if (!secret) return json({ error: "服务器未配置 LICENSE_SECRET" }, 500);
    const bound = String(env.LICENSE_DOMAIN || "").trim();
    const verified = await parseAndVerifyLicense(secret, key);
    if (!verified.ok) return json({ error: verified.error }, 400);
    if (bound) {
      const bd = normalizeDomain(bound);
      if (verified.payload.domain !== bd && verified.payload.domain !== "localhost") {
        return json(
          { error: `授权码域名与本安装包不符（授权: ${verified.payload.domain}，安装包: ${bd}）` },
          400,
        );
      }
    }
    // 先写入再按当前 Host 校验，避免写错码
    await saveLicenseKey(env, key);
    const st = await checkLicense(env, request);
    if (!st.ok) {
      await clearLicenseKey(env);
      return json({ error: st.reason || "激活失败", license: st }, 400);
    }
    return json({ ok: true, license: st });
  }

  // 以下接口：开启授权后必须先激活
  const licenseBlock = await requireLicense(env, request);
  if (licenseBlock && path !== "/api/v1/license" && path !== "/api/v1/license/activate") {
    // ui-settings GET / bg-proxy 仍允许（登录页背景）；其余拦截
    const allowWithoutLicense =
      (path === "/api/v1/ui-settings" && request.method === "GET") ||
      (path === "/api/v1/bg-proxy" && request.method === "GET");
    if (!allowWithoutLicense) return licenseBlock;
  }

  // 公开分享报表 / 分享日成交（无需登录，但站点需已授权）
  if (path.startsWith("/api/v1/share/") && request.method === "GET") {
    const rest = path.slice("/api/v1/share/".length);
    const parts = rest.split("/").filter(Boolean);
    const id = decodeURIComponent(parts[0] || "");
    if (!id) return json({ error: "missing id" }, 400);
    if (parts[1] === "trades") return getPublicShareTrades(env, id, url);
    if (parts.length > 1) return json({ error: "not found" }, 404);
    return getPublicShare(env, id, request);
  }

  // 外观设置可读（登录页也要换背景）
  if (path === "/api/v1/ui-settings" && request.method === "GET") {
    return json(await getUiSettings(env));
  }

  // 背景图代理：绕过壁纸站防盗链（Referer 403）
  if (path === "/api/v1/bg-proxy" && request.method === "GET") {
    return proxyBackgroundImage(env, request, url);
  }

  if (path === "/api/v1/login" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      token?: string;
    };
    const username = String(body.username || "").trim() || (await getAdminUsername(env));
    const password = String(body.password || body.token || "");
    const ip = clientIp(request);
    const gate = assertLoginAllowed(ip, username);
    if (!gate.ok) {
      return json(
        { error: `尝试过多，请 ${gate.retryAfter} 秒后再试` },
        429,
        { "Retry-After": String(gate.retryAfter) },
      );
    }
    if (!(await verifyAdminLogin(env, username, password))) {
      recordLoginFailure(ip, username);
      return json({ error: "账号或密码错误" }, 401);
    }
    clearLoginFailures(ip, username);
    const session = await createAdminSession(env);
    return json(
      { ok: true, username: await getAdminUsername(env) },
      200,
      { "Set-Cookie": adminCookie(session, url.protocol === "https:") },
    );
  }

  if (path === "/api/v1/logout" && request.method === "POST") {
    await destroyAdminSession(env, getAdminSessionId(request));
    return json({ ok: true }, 200, { "Set-Cookie": clearAdminCookie(url.protocol === "https:") });
  }

  if (!(await validateAdminSession(env, getAdminSessionId(request)))) {
    return json({ error: "unauthorized" }, 401);
  }
  const adminUser = await getAdminUsername(env);

  if (path === "/api/v1/me") {
    const license = await checkLicense(env, request);
    return json({ ok: true, username: adminUser, license });
  }

  // 修改管理员账号 / 密码
  if (path === "/api/v1/admin/change-password" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      old_password?: string;
      new_username?: string;
      new_password?: string;
      confirm_password?: string;
    };
    const oldP = String(body.old_password || "");
    const newUser = String(body.new_username || "").trim();
    const newP = String(body.new_password || "").trim();
    const confirm = String(body.confirm_password || "").trim();
    if (!(await verifyAdminPassword(env, oldP))) {
      return json({ error: "当前密码不正确" }, 400);
    }
    if (!newUser && !newP) {
      return json({ error: "请填写新账号或新密码" }, 400);
    }
    if (newP) {
      if (newP !== confirm) return json({ error: "两次输入的新密码不一致" }, 400);
      try {
        await setAdminPassword(env, newP);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "保存失败" }, 400);
      }
    }
    if (newUser) {
      try {
        await setAdminUsername(env, newUser);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "保存失败" }, 400);
      }
    }
    await revokeAllAdminSessions(env);
    const nextUser = await getAdminUsername(env);
    const session = await createAdminSession(env);
    return json(
      { ok: true, username: nextUser },
      200,
      { "Set-Cookie": adminCookie(session, url.protocol === "https:") },
    );
  }

  // 管理员查看/清除本机授权
  if (path === "/api/v1/license/clear" && request.method === "POST") {
    await clearLicenseKey(env);
    return json({ ok: true });
  }
  if (path === "/api/v1/overview") return overview(env, url);
  if (path === "/api/v1/tree") return tree(env);
  if (path === "/api/v1/workspace") return workspace(env);
  if (path === "/api/v1/home-cards") return homeCards(env);
  if (path === "/api/v1/pnl") return pnl(env, url);
  if (path === "/api/v1/snapshots") return snapshots(env, url);
  if (path === "/api/v1/positions") return positions(env, url);
  if (path === "/api/v1/trades") return trades(env, url);
  if (path === "/api/v1/logs") return logs(env, url);
  if (path === "/api/v1/alerts" && request.method === "GET") return alerts(env, url);
  if (path === "/api/v1/alerts/sound-status" && request.method === "GET") return alertSoundStatus(env);
  if (path === "/api/v1/alerts/ack" && request.method === "POST") return ackAlerts(env, request);
  if (path === "/api/v1/alerts/clear-read" && request.method === "POST") return clearReadAlerts(env);
  if (path === "/api/v1/alert-settings" && request.method === "GET") return getAlertSettingsApi(env);
  if (path === "/api/v1/alert-settings" && request.method === "POST") return saveAlertSettingsApi(env, request);
  if (path === "/api/v1/alert-settings/test" && request.method === "POST") return testNotifyApi(env, request);
  if (path === "/api/v1/ui-settings" && request.method === "POST") return saveUiSettingsApi(env, request);
  if (path === "/api/v1/export/trades.csv") return exportTrades(env, url);

  if (path === "/api/v1/admin/groups" && request.method === "GET") return listGroups(env);
  if (path === "/api/v1/admin/groups" && request.method === "POST") return createGroup(env, request);
  if (path.startsWith("/api/v1/admin/groups/") && request.method === "PATCH") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/groups/".length));
    return renameGroup(env, id, request);
  }
  if (path.startsWith("/api/v1/admin/groups/") && request.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/groups/".length));
    return deleteGroup(env, id);
  }

  if (path === "/api/v1/admin/terminals" && request.method === "GET") return listTerminals(env);
  if (path === "/api/v1/admin/terminals" && request.method === "POST") return createTerminal(env, request);
  if (path.startsWith("/api/v1/admin/terminals/") && path.endsWith("/shares") && request.method === "GET") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/terminals/".length, -"/shares".length));
    return listShares(env, id);
  }
  if (path.startsWith("/api/v1/admin/terminals/") && path.endsWith("/shares") && request.method === "POST") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/terminals/".length, -"/shares".length));
    const body = (await request.json().catch(() => ({}))) as {
      hours?: number;
      show_calendar?: boolean;
      show_books?: boolean;
      refresh_sec?: number;
    };
    return createShare(env, id, {
      hours: Number(body.hours || 24),
      show_calendar: body.show_calendar !== false,
      show_books: body.show_books !== false,
      refresh_sec: body.refresh_sec,
    });
  }
  if (path.startsWith("/api/v1/admin/shares/") && path.endsWith("/stop") && request.method === "POST") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/shares/".length, -"/stop".length));
    return stopShare(env, id);
  }
  if (path.startsWith("/api/v1/admin/shares/") && path.endsWith("/extend") && request.method === "POST") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/shares/".length, -"/extend".length));
    return extendShare(env, id, 3);
  }
  if (path.startsWith("/api/v1/admin/shares/") && request.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/shares/".length));
    return deleteShare(env, id);
  }
  if (path.startsWith("/api/v1/admin/terminals/") && path.endsWith("/rotate") && request.method === "POST") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/terminals/".length, -"/rotate".length));
    return rotateSecret(env, id);
  }
  if (path.startsWith("/api/v1/admin/terminals/") && request.method === "PATCH") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/terminals/".length));
    return patchTerminal(env, id, request);
  }
  if (path.startsWith("/api/v1/admin/terminals/") && request.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/v1/admin/terminals/".length));
    return deleteTerminal(env, id);
  }

  return json({ error: "not found" }, 404);
}

async function overview(env: Env, url: URL): Promise<Response> {
  const ts = nowSec();
  const settings = await getAlertSettings(env);
  const gap = Math.max(60, settings.offline_after_seconds || 180);
  const groupId = String(q(url, "group_id") || "").trim();
  const scoped = Boolean(groupId && groupId !== "all");
  const termScope = scoped ? ` AND COALESCE(t.group_id, 'default') = ?` : "";
  const tradeScope = scoped
    ? ` AND terminal_id IN (SELECT terminal_id FROM terminals t WHERE COALESCE(t.group_id, 'default') = ?)`
    : "";
  const posScope = scoped
    ? ` AND terminal_id IN (SELECT terminal_id FROM terminals t WHERE COALESCE(t.group_id, 'default') = ?)`
    : "";

  const run = <T>(sql: string, binds: unknown[] = []) => {
    const stmt = env.DB.prepare(sql);
    return (binds.length ? stmt.bind(...binds) : stmt).first<T>();
  };

  const terminals = await run<{ c: number }>(
    `SELECT COUNT(*) AS c FROM terminals t WHERE 1=1${termScope}`,
    scoped ? [groupId] : [],
  );
  const onlineCnt = await run<{ o: number }>(
    `SELECT COUNT(*) AS o FROM terminals t
     WHERE t.last_seen IS NOT NULL AND t.last_seen >= ?${termScope}`,
    scoped ? [ts - gap, groupId] : [ts - gap],
  );
  const eas = await run<{ c: number }>(
    scoped
      ? `SELECT COUNT(*) AS c FROM eas e
         JOIN terminals t ON t.terminal_id = e.terminal_id
         WHERE COALESCE(t.group_id, 'default') = ?`
      : `SELECT COUNT(*) AS c FROM eas`,
    scoped ? [groupId] : [],
  );
  const openAlerts = await run<{ c: number }>(`SELECT COUNT(*) AS c FROM alerts WHERE acked = 0`);
  const last = await run<{ equity: number; balance: number; floating: number }>(
    `SELECT COALESCE(SUM(x.equity),0) AS equity,
            COALESCE(SUM(x.balance),0) AS balance,
            COALESCE(SUM(x.floating_pl),0) AS floating
     FROM (
       SELECT e.equity,
              e.balance,
              COALESCE((
                SELECT SUM(p.profit) FROM positions_latest p
                WHERE p.terminal_id = e.terminal_id AND p.kind = 'position'
              ), 0) AS floating_pl
       FROM eas e
       JOIN terminals t ON t.terminal_id = e.terminal_id
       WHERE t.last_seen IS NOT NULL AND t.last_seen >= ?
         AND e.last_heartbeat = (
           SELECT MAX(e2.last_heartbeat) FROM eas e2 WHERE e2.terminal_id = e.terminal_id
         )${termScope}
     ) x`,
    scoped ? [ts - gap, groupId] : [ts - gap],
  );
  const pos = await run<{ c: number }>(
    `SELECT COUNT(*) AS c FROM positions_latest WHERE kind = 'position'${posScope}`,
    scoped ? [groupId] : [],
  );
  const dayStart = beijingDayStartSec(ts);
  const monthStart = beijingMonthStartSec(ts);
  const today = await run<{ pnl: number }>(
    `SELECT COALESCE(SUM(profit + commission + swap),0) AS pnl FROM trades WHERE ts >= ?${tradeScope}`,
    scoped ? [dayStart, groupId] : [dayStart],
  );
  const month = await run<{ pnl: number }>(
    `SELECT COALESCE(SUM(profit + commission + swap),0) AS pnl FROM trades WHERE ts >= ?${tradeScope}`,
    scoped ? [monthStart, groupId] : [monthStart],
  );
  const allTime = await run<{ pnl: number }>(
    `SELECT COALESCE(SUM(profit + commission + swap),0) AS pnl FROM trades WHERE 1=1${tradeScope}`,
    scoped ? [groupId] : [],
  );
  return json({
    now: ts,
    group_id: scoped ? groupId : "all",
    terminals: Number(terminals?.c || 0),
    online: Number(onlineCnt?.o || 0),
    eas: Number(eas?.c || 0),
    open_alerts: Number(openAlerts?.c || 0),
    equity: Number(last?.equity || 0),
    balance: Number(last?.balance || 0),
    floating: Number(last?.floating || 0),
    positions: Number(pos?.c || 0),
    today_pnl: Number(today?.pnl || 0),
    month_pnl: Number(month?.pnl || 0),
    total_pnl: Number(allTime?.pnl || 0),
    realtime_pnl: Number(allTime?.pnl || 0) + Number(last?.floating || 0),
  });
}

async function tree(env: Env): Promise<Response> {
  return workspace(env);
}

async function workspace(env: Env): Promise<Response> {
  await ensureDefaultGroup(env);
  await ensureTerminalAlertColumns(env);
  const settings = await getAlertSettings(env);
  const ts = nowSec();
  const groups = await env.DB.prepare(`SELECT * FROM groups ORDER BY sort_order, created_at`).all<{
    id: string;
    name: string;
    sort_order: number;
  }>();
  const terminals = await env.DB.prepare(
    `SELECT terminal_id, name, note, group_id, computer_id, computer_name, platform, broker, server,
            account, account_name, currency, online, last_seen, last_error, report_interval, created_at,
            COALESCE(float_profit_alert, 0) AS float_profit_alert,
            COALESCE(float_loss_alert, 0) AS float_loss_alert,
            COALESCE(display_unit, '') AS display_unit,
            COALESCE(share_intro, '') AS share_intro,
            COALESCE(share_contact, '') AS share_contact
     FROM terminals ORDER BY created_at DESC`,
  ).all();
  const eas = await env.DB.prepare(`SELECT * FROM eas ORDER BY ea_name, magic`).all();
  const byTerm = new Map<string, unknown[]>();
  for (const ea of eas.results || []) {
    const t = String((ea as { terminal_id: string }).terminal_id);
    const list = byTerm.get(t) || [];
    list.push(ea);
    byTerm.set(t, list);
  }
  const enriched = (terminals.results || []).map((t) => {
    const row = t as { terminal_id: string; group_id?: string; last_seen?: number };
    const on = liveOnline(Number(row.last_seen || 0), settings.offline_after_seconds, ts);
    return { ...row, online: on ? 1 : 0, eas: byTerm.get(row.terminal_id) || [] };
  });
  const ungrouped = enriched.filter((t) => !t.group_id);
  const grouped = (groups.results || []).map((g) => ({
    ...g,
    instances: enriched.filter((t) => t.group_id === g.id),
  }));
  return json({ groups: grouped, ungrouped });
}

async function homeCards(env: Env): Promise<Response> {
  await ensureDefaultGroup(env);
  await ensureTerminalAlertColumns(env);
  const ts = nowSec();
  const settings = await getAlertSettings(env);
  const dayStart = beijingDayStartSec(ts);
  const yDayStart = dayStart - 86400;

  const groups = await env.DB.prepare(`SELECT id, name FROM groups`).all<{ id: string; name: string }>();
  const groupName = new Map((groups.results || []).map((g) => [g.id, g.name]));

  const terminals = await env.DB.prepare(
    `SELECT terminal_id, name, note, group_id, account, platform, online, last_seen, last_error,
            COALESCE(display_unit, '') AS display_unit,
            COALESCE(quote_digits, 2) AS quote_digits,
            COALESCE(leverage, 0) AS leverage,
            COALESCE(min_floating_pl, 0) AS min_floating_pl,
            COALESCE(today_min_floating_pl, 0) AS today_min_floating_pl,
            COALESCE(today_min_day, 0) AS today_min_day,
            COALESCE(float_profit_latched, 0) AS float_profit_latched,
            COALESCE(float_loss_latched, 0) AS float_loss_latched
     FROM terminals ORDER BY created_at DESC`,
  ).all<{
    terminal_id: string;
    name: string;
    note: string;
    group_id: string;
    account: string;
    platform: string;
    online: number;
    last_seen: number;
    last_error: string;
    display_unit: string;
    quote_digits: number;
    leverage: number;
    min_floating_pl: number;
    today_min_floating_pl: number;
    today_min_day: number;
    float_profit_latched: number;
    float_loss_latched: number;
  }>();

  const cards = [];
  for (const t of terminals.results || []) {
    const on = liveOnline(t.last_seen || 0, settings.offline_after_seconds, ts);
    const ea = await env.DB.prepare(
      `SELECT balance, equity, floating_pl, position_count, pending_count
       FROM eas WHERE terminal_id = ? ORDER BY last_heartbeat DESC LIMIT 1`,
    )
      .bind(t.terminal_id)
      .first<{
        balance: number;
        equity: number;
        floating_pl: number;
        position_count: number;
        pending_count: number;
      }>();

    const lots = await env.DB.prepare(
      `SELECT COALESCE(SUM(volume),0) AS lots,
              COUNT(*) AS cnt,
              COALESCE(SUM(profit),0) AS floating,
              COALESCE(MAX(COALESCE(spread,0)),0) AS spread
       FROM positions_latest WHERE terminal_id = ? AND kind = 'position'`,
    )
      .bind(t.terminal_id)
      .first<{ lots: number; cnt: number; floating: number; spread: number }>();

    const today = await env.DB.prepare(
      `SELECT COALESCE(SUM(profit + commission + swap),0) AS pnl FROM trades
       WHERE terminal_id = ? AND ts >= ?`,
    )
      .bind(t.terminal_id, dayStart)
      .first<{ pnl: number }>();

    const yesterday = await env.DB.prepare(
      `SELECT COALESCE(SUM(profit + commission + swap),0) AS pnl FROM trades
       WHERE terminal_id = ? AND ts >= ? AND ts < ?`,
    )
      .bind(t.terminal_id, yDayStart, dayStart)
      .first<{ pnl: number }>();

    const closes = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(profit + commission + swap), 0) AS pnl,
              MAX(ts) AS last_ts
       FROM trades
       WHERE terminal_id = ? AND ts >= ?
         AND (entry = 'out' OR entry = 'inout' OR entry = '' OR entry IS NULL)`,
    )
      .bind(t.terminal_id, dayStart)
      .first<{ cnt: number; pnl: number; last_ts: number | null }>();

    const maxDd = await env.DB.prepare(
      `SELECT MIN(floating_pl) AS hist_mn,
              MIN(CASE WHEN ts >= ? THEN floating_pl END) AS today_mn
       FROM snapshots WHERE terminal_id = ?`,
    )
      .bind(dayStart, t.terminal_id)
      .first<{ hist_mn: number | null; today_mn: number | null }>();

    // 浮盈以持仓明细合计为准（eas.floating_pl 可能只含某一个 magic）
    const posCnt = Number(lots?.cnt ?? 0);
    const floating = posCnt === 0 ? 0 : Number(lots?.floating ?? 0);
    const histMin = maxDd?.hist_mn != null ? Number(maxDd.hist_mn) : floating;
    const todayMin = maxDd?.today_mn != null ? Number(maxDd.today_mn) : floating;
    const eaAllMin = Number(t.min_floating_pl || 0);
    const eaTodayMin = Number(t.today_min_day || 0) === dayStart
      ? Number(t.today_min_floating_pl || 0)
      : floating;
    const maxFloatLoss = Math.abs(Math.min(0, histMin, eaAllMin, floating));
    const todayMaxFloatLoss = Math.abs(Math.min(0, todayMin, eaTodayMin, floating));
    const safe = !t.last_error && on && floating > -Math.max(500, maxFloatLoss * 2);
    const alerting =
      (settings.alert_float_profit !== false && Number(t.float_profit_latched || 0) === 1) ||
      (settings.alert_float_loss !== false && Number(t.float_loss_latched || 0) === 1);

    const gid = t.group_id || "default";
    cards.push({
      terminal_id: t.terminal_id,
      name: t.name || t.terminal_id,
      note: t.note || t.name || t.terminal_id,
      group_id: gid,
      group_name: groupName.get(gid) || "默认分组",
      account: t.account || "",
      display_unit: String(t.display_unit || "").trim(),
      quote_digits: Number(t.quote_digits || 2),
      leverage: Number(t.leverage || 0),
      online: on,
      last_seen: t.last_seen || 0,
      // 以 positions_latest 为准；cnt 为 0 时不能用 || 回退到 eas 旧值（会把「0 持仓」显示成 1）
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
    });
  }

  return json({ cards });
}

async function ensureDefaultGroup(env: Env): Promise<void> {
  const n = await env.DB.prepare(`SELECT COUNT(*) AS c FROM groups`).first<{ c: number }>();
  if ((n?.c || 0) === 0) {
    const ts = nowSec();
    await env.DB.prepare(`INSERT INTO groups (id, name, sort_order, created_at) VALUES (?, ?, 0, ?)`)
      .bind("default", "默认分组", ts)
      .run();
  }
  await ensureTerminalAlertColumns(env);
}

async function pnl(env: Env, url: URL): Promise<Response> {
  const terminalId = q(url, "terminal_id");
  const groupId = q(url, "group_id");
  // 默认拉近两年，避免漏掉「本月+上月」补传；上限放宽，防止服务器时钟偏慢把成交滤掉
  const from = finiteNumber(q(url, "from"), nowSec() - 730 * 86400);
  const to = finiteNumber(q(url, "to"), nowSec() + 14 * 86400);

  // 单实例：与分享页共用同一套日汇总，避免两套算法漂移
  if (terminalId && !groupId) {
    const { daily: cumulative, total_pnl } = await buildTerminalDailyPnl(env, terminalId, from, to);
    const monthly = await env.DB.prepare(
      `SELECT ${SQL_BJ_MONTH_T} AS month,
              COALESCE(SUM(t.profit + t.commission + t.swap),0) AS pnl,
              COUNT(*) AS trades
       FROM trades t
       WHERE t.terminal_id = ? AND t.ts >= ? AND t.ts <= ?
       GROUP BY 1 ORDER BY 1`,
    )
      .bind(terminalId, from, to)
      .all();
    return json({
      daily: cumulative,
      monthly: monthly.results || [],
      total_pnl,
    });
  }

  const { daily, monthly, total_pnl } = await buildScopedDailyPnl(env, from, to, {
    groupId: groupId || undefined,
  });
  return json({ daily, monthly, total_pnl });
}

async function snapshots(env: Env, url: URL): Promise<Response> {
  const terminalId = q(url, "terminal_id");
  const eaId = q(url, "ea_id");
  const from = finiteNumber(q(url, "from"), nowSec() - 86400);
  const to = finiteNumber(q(url, "to"), nowSec());
  const span = Math.max(1, to - from);
  const bucket = span > 7 * 86400 ? 900 : span > 2 * 86400 ? 300 : 60;
  let sql = `SELECT (ts / ?) * ? AS ts, AVG(balance) AS balance, AVG(equity) AS equity,
                    AVG(floating_pl) AS floating_pl, AVG(position_count) AS position_count
             FROM snapshots WHERE ts >= ? AND ts <= ?`;
  const binds: unknown[] = [bucket, bucket, from, to];
  if (terminalId) {
    sql += ` AND terminal_id = ?`;
    binds.push(terminalId);
  }
  if (eaId) {
    sql += ` AND ea_id = ?`;
    binds.push(eaId);
  }
  sql += ` GROUP BY 1 ORDER BY 1 LIMIT 2500`;
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return json({ bucket, points: rows.results || [] });
}

async function positions(env: Env, url: URL): Promise<Response> {
  const terminalId = q(url, "terminal_id");
  const magic = q(url, "magic");
  const symbol = q(url, "symbol");
  let sql = `SELECT * FROM positions_latest WHERE 1=1`;
  const binds: unknown[] = [];
  if (terminalId) {
    sql += ` AND terminal_id = ?`;
    binds.push(terminalId);
  }
  if (magic) {
    sql += ` AND magic = ?`;
    binds.push(finiteNumber(magic, 0));
  }
  if (symbol) {
    sql += ` AND symbol = ?`;
    binds.push(symbol);
  }
  sql += ` ORDER BY kind, symbol, ticket LIMIT 1000`;
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return json({ rows: rows.results || [] });
}

function tradeFilters(url: URL): { sql: string; binds: unknown[] } {
  let sql = ` FROM trades WHERE ts >= ? AND ts <= ?`;
  const from = finiteNumber(q(url, "from"), nowSec() - 7 * 86400);
  const to = finiteNumber(q(url, "to"), nowSec());
  const binds: unknown[] = [from, to];
  // 列名白名单：禁止把请求参数直接拼进 SQL 标识符
  const COLS: Record<string, string> = {
    terminal_id: "terminal_id",
    account: "account",
    symbol: "symbol",
    ea_name: "ea_name",
  };
  for (const [param, col] of Object.entries(COLS)) {
    const v = q(url, param);
    if (!v) continue;
    sql += ` AND ${col} = ?`;
    binds.push(v);
  }
  if (q(url, "magic")) {
    sql += ` AND magic = ?`;
    binds.push(finiteNumber(q(url, "magic"), 0));
  }
  const qText = q(url, "q");
  if (qText) {
    sql += ` AND (symbol LIKE ? ESCAPE '\\' OR comment LIKE ? ESCAPE '\\' OR ea_name LIKE ? ESCAPE '\\' OR ticket LIKE ? ESCAPE '\\')`;
    const like = `%${likeEscape(qText)}%`;
    binds.push(like, like, like, like);
  }
  return { sql, binds };
}

async function trades(env: Env, url: URL): Promise<Response> {
  await ensureTerminalAlertColumns(env);
  const { sql, binds } = tradeFilters(url);
  const limit = clampInt(q(url, "limit"), 20, 500, 100);
  const offset = clampInt(q(url, "offset"), 0, 1_000_000, 0);
  const raw = await env.DB.prepare(`SELECT * ${sql} ORDER BY ts DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all();
  const count = await env.DB.prepare(`SELECT COUNT(*) AS c ${sql}`).bind(...binds).first<{ c: number }>();
  let brokerGmtOffset = 0;
  let quoteDigits = 2;
  const terminalId = q(url, "terminal_id");
  if (terminalId) {
    const term = await env.DB.prepare(
      `SELECT COALESCE(broker_gmt_offset, 0) AS broker_gmt_offset,
              COALESCE(quote_digits, 2) AS quote_digits
       FROM terminals WHERE terminal_id = ?`,
    )
      .bind(terminalId)
      .first<{ broker_gmt_offset: number; quote_digits: number }>();
    brokerGmtOffset = Number(term?.broker_gmt_offset || 0);
    quoteDigits = Number(term?.quote_digits || 2);
  }
  const rows = await withOpenPrices(
    env,
    (raw.results || []) as Record<string, unknown>[],
    terminalId || "",
  );
  return json({
    rows,
    total: count?.c || 0,
    limit,
    offset,
    broker_gmt_offset: brokerGmtOffset,
    quote_digits: quoteDigits,
  });
}

async function exportTrades(env: Env, url: URL): Promise<Response> {
  const { sql, binds } = tradeFilters(url);
  const rows = await env.DB.prepare(`SELECT * ${sql} ORDER BY ts DESC LIMIT 10000`).bind(...binds).all<Record<string, unknown>>();
  const cols = [
    "ts", "terminal_id", "account", "ea_name", "ticket", "magic", "symbol", "side", "entry",
    "volume", "price", "sl", "tp", "profit", "commission", "swap", "comment",
  ];
  const lines = [cols.join(",")];
  for (const r of rows.results || []) {
    lines.push(cols.map((c) => csvCell(r[c])).join(","));
  }
  const bom = "\uFEFF";
  return new Response(bom + lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="trades.csv"`,
    },
  });
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

async function logs(env: Env, url: URL): Promise<Response> {
  const terminalId = q(url, "terminal_id");
  const level = q(url, "level");
  let sql = `SELECT * FROM logs WHERE ts >= ?`;
  const binds: unknown[] = [finiteNumber(q(url, "from"), nowSec() - 86400)];
  if (terminalId) {
    sql += ` AND terminal_id = ?`;
    binds.push(terminalId);
  }
  if (level) {
    sql += ` AND level = ?`;
    binds.push(level);
  }
  sql += ` ORDER BY ts DESC LIMIT 300`;
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return json({ rows: rows.results || [] });
}

async function alertSoundStatus(env: Env): Promise<Response> {
  await ensureTerminalAlertColumns(env);
  const settings = await getAlertSettings(env);
  const profitOn = settings.alert_float_profit !== false;
  const lossOn = settings.alert_float_loss !== false;
  if (!profitOn && !lossOn) {
    return json({ active: false, count: 0, profit: 0, loss: 0 });
  }
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN COALESCE(float_profit_latched, 0) = 1 THEN 1 ELSE 0 END) AS profit_n,
       SUM(CASE WHEN COALESCE(float_loss_latched, 0) = 1 THEN 1 ELSE 0 END) AS loss_n
     FROM terminals`,
  ).first<{ profit_n: number | null; loss_n: number | null }>();
  const profit = profitOn ? Number(row?.profit_n || 0) : 0;
  const loss = lossOn ? Number(row?.loss_n || 0) : 0;
  const count = profit + loss;
  return json({ active: count > 0, count, profit, loss });
}

async function alerts(env: Env, url: URL): Promise<Response> {
  const acked = q(url, "acked");
  let sql = `SELECT * FROM alerts WHERE 1=1`;
  const binds: unknown[] = [];
  if (acked === "0" || acked === "1") {
    sql += ` AND acked = ?`;
    binds.push(Number(acked));
  }
  sql += ` ORDER BY ts DESC LIMIT 200`;
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return json({ rows: rows.results || [] });
}

async function ackAlerts(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { id?: number; all?: boolean };
  if (body.all) {
    await env.DB.prepare(`UPDATE alerts SET acked = 1 WHERE acked = 0`).run();
  } else if (body.id) {
    await env.DB.prepare(`UPDATE alerts SET acked = 1 WHERE id = ?`).bind(body.id).run();
  }
  return json({ ok: true });
}

async function clearReadAlerts(env: Env): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM alerts WHERE acked = 1`).run();
  return json({ ok: true, deleted: Number(res.meta?.changes || 0) });
}

async function listGroups(env: Env): Promise<Response> {
  await ensureDefaultGroup(env);
  const rows = await env.DB.prepare(`SELECT * FROM groups ORDER BY sort_order, created_at`).all();
  return json({ rows: rows.results || [] });
}

async function createGroup(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = String(body.name || "").trim();
  if (!name) return json({ error: "name required" }, 400);
  const id = `g_${crypto.randomUUID().slice(0, 8)}`;
  const ts = nowSec();
  await env.DB.prepare(`INSERT INTO groups (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)`)
    .bind(id, name, ts, ts)
    .run();
  return json({ id, name });
}

async function renameGroup(env: Env, id: string, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = String(body.name || "").trim();
  if (!name) return json({ error: "name required" }, 400);
  const res = await env.DB.prepare(`UPDATE groups SET name = ? WHERE id = ?`).bind(name, id).run();
  if (!res.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true, id, name });
}

async function deleteGroup(env: Env, id: string): Promise<Response> {
  if (id === "default") return json({ error: "cannot delete default group" }, 400);
  await env.DB.batch([
    env.DB.prepare(`UPDATE terminals SET group_id = 'default' WHERE group_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM groups WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

async function listTerminals(env: Env): Promise<Response> {
  const settings = await getAlertSettings(env);
  const ts = nowSec();
  const rows = await env.DB.prepare(
    `SELECT terminal_id, name, note, group_id, computer_id, computer_name, platform, account, server, online, last_seen, created_at
     FROM terminals ORDER BY created_at DESC`,
  ).all<{
    terminal_id: string;
    name: string;
    note: string;
    group_id: string;
    computer_id: string;
    computer_name: string;
    platform: string;
    account: string;
    server: string;
    online: number;
    last_seen: number;
    created_at: number;
  }>();
  return json({
    rows: (rows.results || []).map((t) => ({
      ...t,
      online: liveOnline(t.last_seen || 0, settings.offline_after_seconds, ts) ? 1 : 0,
    })),
  });
}

async function createTerminal(env: Env, request: Request): Promise<Response> {
  await ensureDefaultGroup(env);
  const body = (await request.json().catch(() => ({}))) as {
    terminal_id?: string;
    name?: string;
    note?: string;
    group_id?: string;
    computer_id?: string;
  };
  let terminalId = String(body.terminal_id || "").trim();
  if (!terminalId) terminalId = `EA-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const exists = await env.DB.prepare(`SELECT terminal_id FROM terminals WHERE terminal_id = ?`)
    .bind(terminalId)
    .first();
  if (exists) return json({ error: "terminal already exists, use rotate to change secret" }, 409);
  const secret = randomSecret();
  const ts = nowSec();
  const groupId = String(body.group_id || "default");
  const name = String(body.name || body.note || terminalId).trim() || terminalId;
  const note = String(body.note || body.name || "").trim() || name;
  await env.DB.prepare(
    `INSERT INTO terminals (terminal_id, api_secret, name, note, group_id, computer_id, created_at, updated_at, online)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(terminalId, secret, name, note, groupId, String(body.computer_id || ""), ts, ts)
    .run();
  return json({
    terminal_id: terminalId,
    api_secret: secret,
    name,
    note,
    group_id: groupId,
    hint: "把 terminal_id 和 api_secret 填进 EA 参数即可对接；私钥只显示一次。",
  });
}

async function patchTerminal(env: Env, id: string, request: Request): Promise<Response> {
  await ensureTerminalAlertColumns(env);
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    note?: string;
    group_id?: string | null;
    new_terminal_id?: string;
    float_profit_alert?: number | string;
    float_loss_alert?: number | string;
    display_unit?: string | null;
    share_intro?: string | null;
    share_contact?: string | null;
  };
  const row = await env.DB.prepare(
    `SELECT terminal_id, name, note, group_id,
            COALESCE(float_profit_alert,0) AS float_profit_alert,
            COALESCE(float_loss_alert,0) AS float_loss_alert,
            COALESCE(display_unit,'') AS display_unit,
            COALESCE(share_intro,'') AS share_intro,
            COALESCE(share_contact,'') AS share_contact
     FROM terminals WHERE terminal_id = ?`,
  )
    .bind(id)
    .first<{
      terminal_id: string;
      name: string;
      note: string;
      group_id: string;
      float_profit_alert: number;
      float_loss_alert: number;
      display_unit: string;
      share_intro: string;
      share_contact: string;
    }>();
  if (!row) return json({ error: "not found" }, 404);

  const remark = body.name != null ? String(body.name).trim() : body.note != null ? String(body.note).trim() : null;
  const nextName = remark != null ? (remark || row.terminal_id) : row.name || row.terminal_id;
  const nextNote = remark != null ? remark : row.note || "";
  const nextGroup =
    body.group_id === undefined || body.group_id === null || body.group_id === ""
      ? row.group_id || "default"
      : String(body.group_id);

  const nextProfit =
    body.float_profit_alert != null
      ? Math.min(999, Math.max(0, Number(body.float_profit_alert) || 0))
      : Number(row.float_profit_alert || 0);
  const nextLoss =
    body.float_loss_alert != null
      ? Math.min(999, Math.max(0, Number(body.float_loss_alert) || 0))
      : Number(row.float_loss_alert || 0);
  const nextUnit =
    body.display_unit === undefined || body.display_unit === null
      ? String(row.display_unit || "").trim()
      : String(body.display_unit).trim().slice(0, 12);
  const nextIntro =
    body.share_intro === undefined || body.share_intro === null
      ? String(row.share_intro || "")
      : String(body.share_intro).replace(/\r\n/g, "\n").slice(0, 2000);
  const nextContact =
    body.share_contact === undefined || body.share_contact === null
      ? String(row.share_contact || "")
      : String(body.share_contact).replace(/\r\n/g, " ").trim().slice(0, 120);

  let nextId = id;
  if (body.new_terminal_id != null) {
    const candidate = String(body.new_terminal_id).trim();
    if (!candidate) return json({ error: "实例 ID 不能为空" }, 400);
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(candidate)) {
      return json({ error: "实例 ID 仅支持字母数字和 ._-，长度 2–64" }, 400);
    }
    if (candidate !== id) {
      const exists = await env.DB.prepare(`SELECT terminal_id FROM terminals WHERE terminal_id = ?`)
        .bind(candidate)
        .first();
      if (exists) return json({ error: "该实例 ID 已存在" }, 409);
      await env.DB.batch([
        env.DB.prepare(`UPDATE eas SET terminal_id = ? WHERE terminal_id = ?`).bind(candidate, id),
        env.DB.prepare(`UPDATE snapshots SET terminal_id = ? WHERE terminal_id = ?`).bind(candidate, id),
        env.DB.prepare(`UPDATE positions_latest SET terminal_id = ? WHERE terminal_id = ?`).bind(candidate, id),
        env.DB.prepare(`UPDATE trades SET terminal_id = ? WHERE terminal_id = ?`).bind(candidate, id),
        env.DB.prepare(`UPDATE logs SET terminal_id = ? WHERE terminal_id = ?`).bind(candidate, id),
        env.DB.prepare(`UPDATE alerts SET terminal_id = ? WHERE terminal_id = ?`).bind(candidate, id),
        env.DB.prepare(`UPDATE terminals SET terminal_id = ? WHERE terminal_id = ?`).bind(candidate, id),
      ]);
      nextId = candidate;
    }
  }

  // 阈值改了就解除锁存，方便立刻按新阈值再报警
  const resetLatch =
    nextProfit !== Number(row.float_profit_alert || 0) || nextLoss !== Number(row.float_loss_alert || 0);

  await env.DB.prepare(
    `UPDATE terminals SET
       name = ?, note = ?, group_id = ?,
       float_profit_alert = ?, float_loss_alert = ?,
       display_unit = ?, share_intro = ?, share_contact = ?,
       float_profit_latched = CASE WHEN ? THEN 0 ELSE float_profit_latched END,
       float_loss_latched = CASE WHEN ? THEN 0 ELSE float_loss_latched END,
       updated_at = ?
     WHERE terminal_id = ?`,
  )
    .bind(
      nextName,
      nextNote,
      nextGroup,
      nextProfit,
      nextLoss,
      nextUnit,
      nextIntro,
      nextContact,
      resetLatch ? 1 : 0,
      resetLatch ? 1 : 0,
      nowSec(),
      nextId,
    )
    .run();

  return json({
    ok: true,
    terminal_id: nextId,
    name: nextName,
    note: nextNote,
    group_id: nextGroup,
    float_profit_alert: nextProfit,
    float_loss_alert: nextLoss,
    display_unit: nextUnit,
    share_intro: nextIntro,
    share_contact: nextContact,
    id_changed: nextId !== id,
  });
}

async function rotateSecret(env: Env, id: string): Promise<Response> {
  const secret = randomSecret();
  const res = await env.DB.prepare(`UPDATE terminals SET api_secret = ?, updated_at = ? WHERE terminal_id = ?`)
    .bind(secret, nowSec(), id)
    .run();
  if (!res.meta.changes) return json({ error: "not found" }, 404);
  return json({ terminal_id: id, api_secret: secret });
}

async function deleteTerminal(env: Env, id: string): Promise<Response> {
  const exists = await env.DB.prepare(`SELECT terminal_id FROM terminals WHERE terminal_id = ?`)
    .bind(id)
    .first();
  if (!exists) return json({ error: "not found" }, 404);

  await deleteSharesForTerminal(env, id);

  // 删实例时一并清掉该 ID 下全部业务数据（不可恢复）
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM positions_latest WHERE terminal_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM snapshots WHERE terminal_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM trades WHERE terminal_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM logs WHERE terminal_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM eas WHERE terminal_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM alerts WHERE terminal_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM terminals WHERE terminal_id = ?`).bind(id),
  ]);

  return json({
    ok: true,
    terminal_id: id,
    deleted: ["positions", "snapshots", "trades", "logs", "eas", "alerts", "shares", "terminal"],
  });
}

export async function parseJsonBody<T>(raw: ArrayBuffer): Promise<T> {
  const text = new TextDecoder().decode(raw);
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

async function getAlertSettingsApi(env: Env): Promise<Response> {
  return json(await getAlertSettings(env));
}

async function saveAlertSettingsApi(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const saved = await saveAlertSettings(env, {
    alert_timeout: body.alert_timeout != null ? !!body.alert_timeout : undefined,
    alert_ea_timeout: body.alert_ea_timeout != null ? !!body.alert_ea_timeout : undefined,
    alert_ea_error: body.alert_ea_error != null ? !!body.alert_ea_error : undefined,
    alert_log_error: body.alert_log_error != null ? !!body.alert_log_error : undefined,
    alert_float_profit: body.alert_float_profit != null ? !!body.alert_float_profit : undefined,
    alert_float_loss: body.alert_float_loss != null ? !!body.alert_float_loss : undefined,
    notify_enabled: body.notify_enabled != null ? !!body.notify_enabled : undefined,
    notify_webhook: body.notify_webhook != null ? String(body.notify_webhook) : undefined,
    notify_webhooks:
      body.notify_webhooks != null && typeof body.notify_webhooks === "object"
        ? (body.notify_webhooks as Record<string, string>)
        : undefined,
    offline_after_seconds: body.offline_after_seconds != null ? Number(body.offline_after_seconds) : undefined,
  });
  return json(saved);
}

async function testNotifyApi(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { group_id?: string };
  const text = sampleAlertMessage();
  const result = await sendNotify(env, text, "test", { groupId: String(body.group_id || "").trim() || undefined });
  if (!result.ok) return json({ ok: false, error: result.detail || "failed" }, 400);
  return json({ ok: true, text });
}

async function saveUiSettingsApi(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  let saved = await saveUiSettings(env, {
    bg_day_desktop: body.bg_day_desktop != null ? String(body.bg_day_desktop) : undefined,
    bg_day_mobile: body.bg_day_mobile != null ? String(body.bg_day_mobile) : undefined,
    bg_night_desktop: body.bg_night_desktop != null ? String(body.bg_night_desktop) : undefined,
    bg_night_mobile: body.bg_night_mobile != null ? String(body.bg_night_mobile) : undefined,
  });
  // Node 部署：外链下载到本站本地（哲风预览链仍是预览清晰度）
  try {
    const mod = await import("../server/bgUpload.ts");
    saved = await mod.cacheRemoteBackgrounds(env, saved);
  } catch {
    /* Workers / 无本地磁盘时跳过 */
  }
  return json(saved);
}

function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

async function proxyBackgroundImage(env: Env, request: Request, url: URL): Promise<Response> {
  const raw = String(url.searchParams.get("url") || "").trim();
  if (!raw || raw.length > 2000) return json({ error: "bad url" }, 400);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: "bad url" }, 400);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return json({ error: "bad protocol" }, 400);
  }
  if (isPrivateHostname(target.hostname)) return json({ error: "blocked host" }, 403);

  const settings = await getUiSettings(env);
  const allowed = new Set(
    [
      settings.bg_day_desktop,
      settings.bg_day_mobile,
      settings.bg_night_desktop,
      settings.bg_night_mobile,
    ].filter(Boolean),
  );
  const targetStr = target.toString();
  const admin = await validateAdminSession(env, getAdminSessionId(request));
  if (!admin && !allowed.has(raw) && !allowed.has(targetStr)) {
    return json({ error: "url not in settings" }, 403);
  }

  try {
    const upstream = await fetch(targetStr, {
      redirect: "follow",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!upstream.ok) return json({ error: `upstream ${upstream.status}` }, 502);
    const ct = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ct.startsWith("image/")) return json({ error: "not an image" }, 502);
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > 12 * 1024 * 1024) return json({ error: "too large" }, 413);
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "fetch failed";
    return json({ error: message }, 502);
  }
}
