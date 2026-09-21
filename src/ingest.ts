import type { Env, HeartbeatPayload, LogPayload, PositionPayload, TradePayload } from "./types";
import { clampStr, eaId, nowSec, num } from "./types";
import { buildAlertMessage } from "./alertMsg";
import { getAlertSettings, sendNotify } from "./settings";
import { ensureTerminalAlertColumns } from "./sqlSafe";
import { beijingDayKeyFromSec, beijingDayStartSec } from "./timeBj";

const MAX_POSITIONS = 400;

/** 券商服务器时间常被当成 UTC 上报（快 2~3 小时），导致北京日切提前进「明天」 */
function normalizeBrokerTs(raw: number, now: number): { ts: number; detectedOffset: number } {
  let ts = Number(raw);
  if (!Number.isFinite(ts) || ts <= 0) return { ts: now, detectedOffset: 0 };
  const skew = ts - now;
  if (skew > 30 * 60 && skew < 14 * 3600) {
    const hours = Math.round(skew / 3600);
    if (hours >= 1) {
      ts -= hours * 3600;
      return { ts, detectedOffset: hours * 3600 };
    }
  }
  return { ts, detectedOffset: 0 };
}

function posKind(p: PositionPayload, fallback: string): string {
  const k = clampStr(p.kind || fallback, 16).toLowerCase();
  return k === "pending" ? "pending" : "position";
}

/** 从报价浮点反推有效小数位（去掉尾零后能还原的最小位数） */
function priceDecimalPlaces(price: number): number {
  if (!Number.isFinite(price)) return -1;
  const abs = Math.abs(price);
  if (abs === 0) return -1;
  for (let d = 0; d <= 8; d++) {
    const f = 10 ** d;
    if (Math.abs(Math.round(abs * f) / f - abs) < 1e-8 * Math.max(1, abs)) return d;
  }
  return 5;
}

/** 用持仓/挂单报价位数推断实例报价位数；无仓则返回 null 不覆盖 */
function inferQuoteDigitsFromPayload(payload: HeartbeatPayload): number | null {
  const prices: number[] = [];
  for (const p of [...(payload.positions || []), ...(payload.pending || [])]) {
    const cur = num(p.price_current, 0);
    const open = num(p.price_open, 0);
    if (cur > 0) prices.push(cur);
    if (open > 0) prices.push(open);
  }
  if (!prices.length) return null;
  const counts = new Map<number, number>();
  for (const p of prices) {
    const d = priceDecimalPlaces(p);
    if (d < 0) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = 2;
  let bestN = 0;
  for (const [d, n] of counts) {
    if (n > bestN || (n === bestN && d > best)) {
      best = d;
      bestN = n;
    }
  }
  return Math.min(8, Math.max(0, best));
}

export async function ingestHeartbeat(env: Env, terminalId: string, payload: HeartbeatPayload): Promise<void> {
  await ensureTerminalAlertColumns(env);
  const ts = nowSec();
  const computerId = clampStr(payload.computer_id || terminalId, 80);
  const account = clampStr(payload.account, 32);
  const interval = Math.max(5, Math.min(600, num(payload.report_interval, 30)));
  const brokerOffset = Math.trunc(num(payload.broker_gmt_offset, Number.NaN));
  const hasBrokerOffset = Number.isFinite(brokerOffset) && Math.abs(brokerOffset) <= 14 * 3600;
  const inferred = inferQuoteDigitsFromPayload(payload);
  const fromPayload = Math.trunc(num(payload.quote_digits, Number.NaN));
  const quoteDigits = inferred != null
    ? inferred
    : Number.isFinite(fromPayload)
      ? Math.min(8, Math.max(0, fromPayload))
      : null;

  const updated = await env.DB.prepare(
    `UPDATE terminals SET
       computer_id=?, computer_name=?, platform=?, mt_build=?, broker=?, server=?,
       account=?, account_name=?, currency=?, leverage=?, report_interval=?,
       online=1, last_seen=?, last_error=?, updated_at=?
       ${quoteDigits != null ? ", quote_digits=?" : ""}
       ${hasBrokerOffset ? ", broker_gmt_offset=?" : ""}
     WHERE terminal_id=?`,
  )
    .bind(
      ...((): unknown[] => {
        const base: unknown[] = [
          computerId,
          clampStr(payload.computer_name, 120),
          clampStr(payload.platform, 16),
          num(payload.mt_build, 0),
          clampStr(payload.broker, 80),
          clampStr(payload.server, 80),
          account,
          clampStr(payload.account_name, 80),
          clampStr(payload.currency, 12),
          num(payload.leverage, 0),
          interval,
          ts,
          clampStr(payload.last_error, 500),
          ts,
        ];
        if (quoteDigits != null) base.push(quoteDigits);
        if (hasBrokerOffset) base.push(brokerOffset);
        base.push(terminalId);
        return base;
      })(),
    )
    .run();
  if (!updated.meta.changes) throw new Error("terminal row missing");

  // EA 每秒本地采样的浮亏最低点：合并进终端，补心跳间隔空洞
  const eaTodayMin = num(payload.today_min_floating, Number.NaN);
  const eaAllMin = num(payload.min_floating, Number.NaN);
  if (Number.isFinite(eaTodayMin) || Number.isFinite(eaAllMin)) {
    const dayStart = beijingDayStartSec(ts);
    const openPos = payload.positions || [];
    const floatingNow = openPos.length > 0
      ? openPos.reduce((a, p) => a + num(p.profit, 0), 0)
      : num(payload.floating_pl, 0);
    const prev = await env.DB.prepare(
      `SELECT COALESCE(min_floating_pl, 0) AS mn,
              COALESCE(today_min_floating_pl, 0) AS tmn,
              COALESCE(today_min_day, 0) AS tday
       FROM terminals WHERE terminal_id = ?`,
    )
      .bind(terminalId)
      .first<{ mn: number; tmn: number; tday: number }>();

    let allMin = Number(prev?.mn ?? 0);
    if (Number.isFinite(eaAllMin)) allMin = Math.min(allMin, eaAllMin);
    allMin = Math.min(allMin, floatingNow);

    let todayMin = Number(prev?.tmn ?? 0);
    let todayDay = Number(prev?.tday ?? 0);
    if (todayDay !== dayStart) {
      todayMin = Number.isFinite(eaTodayMin) ? eaTodayMin : floatingNow;
      todayDay = dayStart;
    } else {
      if (Number.isFinite(eaTodayMin)) todayMin = Math.min(todayMin, eaTodayMin);
      todayMin = Math.min(todayMin, floatingNow);
    }

    await env.DB.prepare(
      `UPDATE terminals SET min_floating_pl=?, today_min_floating_pl=?, today_min_day=? WHERE terminal_id=?`,
    )
      .bind(allMin, todayMin, todayDay, terminalId)
      .run();

    // 写入日历用的「按日最低浮盈」，与卡片今日最大浮亏同源（含 EA 每秒采样）
    const dayKey = beijingDayKeyFromSec(ts);
    const prevDay = await env.DB.prepare(
      `SELECT min_floating FROM daily_float_min WHERE terminal_id = ? AND day = ?`,
    )
      .bind(terminalId, dayKey)
      .first<{ min_floating: number }>();
    const dayMin = prevDay?.min_floating != null
      ? Math.min(Number(prevDay.min_floating), todayMin)
      : todayMin;
    await env.DB.prepare(
      `INSERT INTO daily_float_min (terminal_id, day, min_floating, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(terminal_id, day) DO UPDATE SET
         min_floating = MIN(daily_float_min.min_floating, excluded.min_floating),
         updated_at = excluded.updated_at`,
    )
      .bind(terminalId, dayKey, dayMin, ts)
      .run();
  }

  const eas = Array.isArray(payload.eas) && payload.eas.length > 0
    ? payload.eas.slice(0, 80)
    : [{
        ea_name: "account",
        ea_version: "",
        strategy_tag: "account",
        magic: 0,
        symbol: "",
        timeframe: "",
        started_at: ts,
        status: "running",
        last_error: payload.last_error || "",
        position_count: (payload.positions || []).length,
        pending_count: (payload.pending || []).length,
        floating_pl: num(payload.floating_pl, 0),
      }];

  for (const ea of eas) {
    const id = eaId(terminalId, num(ea.magic, 0), clampStr(ea.symbol, 32), clampStr(ea.ea_name, 80));
    await env.DB.prepare(
      `INSERT INTO eas (
         ea_id, terminal_id, computer_id, account, ea_name, ea_version, strategy_tag,
         magic, symbol, timeframe, started_at, last_heartbeat, status, last_error,
         position_count, pending_count, floating_pl, balance, equity, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ea_id) DO UPDATE SET
         computer_id=excluded.computer_id,
         account=excluded.account,
         ea_version=excluded.ea_version,
         strategy_tag=excluded.strategy_tag,
         symbol=excluded.symbol,
         timeframe=excluded.timeframe,
         last_heartbeat=excluded.last_heartbeat,
         status=excluded.status,
         last_error=excluded.last_error,
         position_count=excluded.position_count,
         pending_count=excluded.pending_count,
         floating_pl=excluded.floating_pl,
         balance=excluded.balance,
         equity=excluded.equity,
         updated_at=excluded.updated_at,
         started_at=COALESCE(eas.started_at, excluded.started_at)`,
    )
      .bind(
        id,
        terminalId,
        computerId,
        account,
        clampStr(ea.ea_name, 80),
        clampStr(ea.ea_version, 32),
        clampStr(ea.strategy_tag, 40),
        num(ea.magic, 0),
        clampStr(ea.symbol, 32),
        clampStr(ea.timeframe, 12),
        num(ea.started_at, ts),
        ts,
        clampStr(ea.status || "running", 24),
        clampStr(ea.last_error, 500),
        num(ea.position_count, 0),
        num(ea.pending_count, 0),
        num(ea.floating_pl, 0),
        num(payload.balance, 0),
        num(payload.equity, 0),
        ts,
        ts,
      )
      .run();

    if (ea.last_error) {
      await insertAlert(env, {
        terminalId,
        eaId: id,
        computerId,
        type: "ea_error",
        severity: "error",
        detail: `EA「${ea.ea_name || id}」回报错误：${ea.last_error}`,
      });
    }
  }

  const primaryEa = eas[0];
  const primaryId = eaId(
    terminalId,
    num(primaryEa.magic, 0),
    clampStr(primaryEa.symbol, 32),
    clampStr(primaryEa.ea_name, 80),
  );

  // 浮盈以持仓明细合计为准，避免只上报了某个 magic 的浮盈
  const openPositions = payload.positions || [];
  const floatingSum = openPositions.reduce((a, p) => a + num(p.profit, 0), 0);
  const floatingUse = openPositions.length > 0 ? floatingSum : 0;

  await env.DB.prepare(
    `INSERT INTO snapshots (
       terminal_id, ea_id, computer_id, account, ts, balance, equity, floating_pl,
       margin, free_margin, margin_level, position_count, pending_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      terminalId,
      primaryId,
      computerId,
      account,
      ts,
      num(payload.balance, 0),
      num(payload.equity, 0),
      floatingUse,
      num(payload.margin, 0),
      num(payload.free_margin, 0),
      num(payload.margin_level, 0),
      openPositions.length,
      (payload.pending || []).length,
    )
    .run();

  const posStmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM positions_latest WHERE terminal_id = ?`).bind(terminalId),
  ];
  const rows = [
    ...(payload.positions || []).slice(0, MAX_POSITIONS).map((p) => ({ ...p, kind: posKind(p, "position") })),
    ...(payload.pending || []).slice(0, MAX_POSITIONS).map((p) => ({ ...p, kind: posKind(p, "pending") })),
  ];
  for (const p of rows) {
    const magic = num(p.magic, 0);
    const symbol = clampStr(p.symbol, 32);
    const name = eas.find((e) => num(e.magic, 0) === magic)?.ea_name || "";
    const id = eaId(terminalId, magic, symbol, clampStr(name, 80));
    posStmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO positions_latest (
           terminal_id, ticket, ea_id, magic, symbol, kind, side, volume, price_open,
           price_current, sl, tp, profit, comment, open_time, updated_at, spread
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        terminalId,
        clampStr(p.ticket, 40) || `${ts}-${Math.random()}`,
        id,
        magic,
        symbol,
        p.kind,
        clampStr(p.side, 12),
        num(p.volume, 0),
        num(p.price_open, 0),
        num(p.price_current, 0),
        num(p.sl, 0),
        num(p.tp, 0),
        num(p.profit, 0),
        clampStr(p.comment, 120),
        (() => {
          const ot = num(p.open_time, 0);
          if (ot <= 0) return 0;
          return normalizeBrokerTs(ot, ts).ts;
        })(),
        ts,
        Math.max(0, num(p.spread, 0)),
      ),
    );
  }
  for (let i = 0; i < posStmts.length; i += 40) {
    await env.DB.batch(posStmts.slice(i, i + 40));
  }

  await checkFloatingAlerts(
    env,
    terminalId,
    computerId,
    floatingUse,
    num(payload.balance, 0),
    num(payload.equity, 0),
  );
}

async function checkFloatingAlerts(
  env: Env,
  terminalId: string,
  computerId: string,
  floating: number,
  balance: number,
  equity: number,
): Promise<void> {
  await ensureTerminalAlertColumns(env);

  const settings = await getAlertSettings(env);
  if (!settings.alert_float_profit && !settings.alert_float_loss) return;

  const row = await env.DB.prepare(
    `SELECT name, note, float_profit_alert, float_loss_alert, float_profit_latched, float_loss_latched
     FROM terminals WHERE terminal_id = ?`,
  )
    .bind(terminalId)
    .first<{
      name: string;
      note: string;
      float_profit_alert: number;
      float_loss_alert: number;
      float_profit_latched: number;
      float_loss_latched: number;
    }>();
  if (!row) return;

  // 相对余额百分比；余额无效时退净值
  const base = balance > 0 ? balance : equity > 0 ? equity : 0;
  if (!(base > 0)) return;
  const pct = (floating / base) * 100;

  const label = row.name || row.note || terminalId;
  const profitTh = settings.alert_float_profit ? Number(row.float_profit_alert || 0) : 0;
  const lossTh = settings.alert_float_loss ? Number(row.float_loss_alert || 0) : 0;
  let profitLatched = Number(row.float_profit_latched || 0) ? 1 : 0;
  let lossLatched = Number(row.float_loss_latched || 0) ? 1 : 0;

  if (profitTh > 0) {
    if (pct >= profitTh && !profitLatched) {
      await insertAlert(env, {
        terminalId,
        computerId,
        type: "float_profit",
        severity: "info",
        detail: `浮盈 ${floating.toFixed(2)}（${pct.toFixed(2)}%），已触及阈值 +${profitTh}%（实例：${label}）`,
      });
      profitLatched = 1;
    } else if (pct < profitTh) {
      profitLatched = 0;
    }
  } else {
    profitLatched = 0;
  }

  if (lossTh > 0) {
    if (pct <= -lossTh && !lossLatched) {
      await insertAlert(env, {
        terminalId,
        computerId,
        type: "float_loss",
        severity: "warn",
        detail: `浮亏 ${floating.toFixed(2)}（${pct.toFixed(2)}%），已触及阈值 -${lossTh}%（实例：${label}）`,
      });
      lossLatched = 1;
    } else if (pct > -lossTh) {
      lossLatched = 0;
    }
  } else {
    lossLatched = 0;
  }

  if (
    profitLatched !== (Number(row.float_profit_latched || 0) ? 1 : 0) ||
    lossLatched !== (Number(row.float_loss_latched || 0) ? 1 : 0)
  ) {
    await env.DB.prepare(
      `UPDATE terminals SET float_profit_latched = ?, float_loss_latched = ?, updated_at = ? WHERE terminal_id = ?`,
    )
      .bind(profitLatched, lossLatched, nowSec(), terminalId)
      .run();
  }
}

export async function ingestTrade(env: Env, terminalId: string, payload: TradePayload): Promise<void> {
  const now = nowSec();
  const norm = normalizeBrokerTs(num(payload.ts, now), now);
  const ts = norm.ts;
  if (norm.detectedOffset > 0) {
    try {
      await env.DB.prepare(
        `UPDATE terminals SET broker_gmt_offset = ? WHERE terminal_id = ? AND COALESCE(broker_gmt_offset, 0) = 0`,
      )
        .bind(norm.detectedOffset, terminalId)
        .run();
    } catch {
      /* column may not exist yet on first boot before ensure */
    }
  }
  const magic = num(payload.magic, 0);
  const symbol = clampStr(payload.symbol, 32);
  const eaName = clampStr(payload.ea_name, 80);
  const ticket = clampStr(payload.ticket, 40);
  const id = clampStr(payload.ea_id, 160) || eaId(terminalId, magic, symbol, eaName || "unknown");

  // 同一实例同一票据不重复入库（首次补传 / 重挂 EA 安全）
  if (ticket) {
    const exists = await env.DB.prepare(
      `SELECT id FROM trades WHERE terminal_id = ? AND ticket = ? LIMIT 1`,
    )
      .bind(terminalId, ticket)
      .first();
    if (exists) return;
  }

  await env.DB.prepare(
    `INSERT INTO trades (
       terminal_id, computer_id, account, ea_id, ea_name, ticket, magic, symbol,
       side, entry, volume, price, sl, tp, profit, commission, swap, comment, ts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      terminalId,
      clampStr(payload.computer_id, 80),
      clampStr(payload.account, 32),
      id,
      eaName,
      ticket,
      magic,
      symbol,
      clampStr(payload.side, 12),
      clampStr(payload.entry, 16),
      num(payload.volume, 0),
      num(payload.price, 0),
      num(payload.sl, 0),
      num(payload.tp, 0),
      num(payload.profit, 0),
      num(payload.commission, 0),
      num(payload.swap, 0),
      clampStr(payload.comment, 120),
      ts,
    )
    .run();
}

export async function ingestLog(env: Env, terminalId: string, payload: LogPayload): Promise<void> {
  const ts = num(payload.ts, nowSec());
  let message = String(payload.message || "").slice(0, 20000);
  let r2Key: string | null = null;
  if (message.length > 1800 && env.LOGS) {
    r2Key = `logs/${terminalId}/${ts}-${crypto.randomUUID()}.txt`;
    await env.LOGS.put(r2Key, message, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    message = message.slice(0, 500) + "…[full log in R2]";
  }
  const level = clampStr(payload.level || "info", 16);
  await env.DB.prepare(
    `INSERT INTO logs (terminal_id, ea_id, ea_name, magic, level, message, r2_key, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      terminalId,
      clampStr(payload.ea_id, 160),
      clampStr(payload.ea_name, 80),
      num(payload.magic, 0),
      level,
      message,
      r2Key,
      ts,
    )
    .run();
  if (level === "error" || level === "fatal") {
    await insertAlert(env, {
      terminalId,
      eaId: clampStr(payload.ea_id, 160),
      computerId: clampStr(payload.computer_id, 80),
      type: "log_error",
      severity: "error",
      detail: `EA「${payload.ea_name || terminalId}」[${level}] ${message.slice(0, 240)}`,
    });
  }
}

export async function insertAlert(
  env: Env,
  row: {
    terminalId: string;
    eaId?: string;
    computerId?: string;
    type: string;
    severity: string;
    /** 情况说明（会套进统一模板） */
    detail: string;
    /** 兼容旧调用；若提供则跳过模板拼装 */
    message?: string;
  },
): Promise<void> {
  const settings = await getAlertSettings(env);
  if (row.type === "timeout" && !settings.alert_timeout) return;
  if (row.type === "ea_timeout" && !settings.alert_ea_timeout) return;
  if (row.type === "ea_error" && !settings.alert_ea_error) return;
  if (row.type === "log_error" && !settings.alert_log_error) return;
  if (row.type === "float_profit" && !settings.alert_float_profit) return;
  if (row.type === "float_loss" && !settings.alert_float_loss) return;

  const message =
    row.message ||
    (await buildAlertMessage(env, {
      terminalId: row.terminalId,
      type: row.type,
      detail: row.detail,
      computerId: row.computerId,
    }));

  // 超时类按 terminal+type 去重，避免文案里带「已停报约 N 秒」导致重复刷屏
  const dedupeSec = row.type === "float_profit" || row.type === "float_loss" ? 3600 : 600;
  const dup =
    row.type === "timeout" || row.type === "ea_timeout"
      ? await env.DB.prepare(
          `SELECT id FROM alerts WHERE terminal_id = ? AND type = ? AND ts > ? LIMIT 1`,
        )
          .bind(row.terminalId, row.type, nowSec() - dedupeSec)
          .first()
      : await env.DB.prepare(
          `SELECT id FROM alerts WHERE terminal_id = ? AND type = ? AND message = ? AND ts > ? LIMIT 1`,
        )
          .bind(row.terminalId, row.type, message, nowSec() - dedupeSec)
          .first();
  if (dup) return;
  await env.DB.prepare(
    `INSERT INTO alerts (terminal_id, ea_id, computer_id, type, severity, message, acked, ts)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(row.terminalId, row.eaId || "", row.computerId || "", row.type, row.severity, message.slice(0, 2000), nowSec())
    .run();
  const notified = await sendNotify(env, message, row.type, { terminalId: row.terminalId });
  if (!notified.ok) {
    console.error(`[notify] failed type=${row.type} terminal=${row.terminalId}: ${notified.detail || "unknown"}`);
  }
}
