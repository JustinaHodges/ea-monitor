import type { Env } from "./types";
import { nowSec } from "./types";
import { SQL_BJ_DAY_S, SQL_BJ_DAY_T, SQL_BJ_MONTH_T, beijingDayKeyFromSec, beijingDayStartSec } from "./timeBj";

export type DailyPnlRow = {
  day: string;
  /** 当日已实现盈亏（当天平仓合计），不是累计 */
  pnl: number;
  /** 从区间首日累加到该日的已实现（仅供曲线/参考，日历大数字不用） */
  cumulative: number;
  trades: number;
  /** 当日最高浮盈 / 净值冲高 / 单笔最大盈利 */
  max_profit: number;
  /** 当日最大回撤：当天净值峰值到谷值（无快照时退化为最差浮亏/单笔） */
  max_drawdown: number;
};

type DayExtreme = {
  max_equity_up: number;
  max_equity_dd: number;
  max_float: number;
  min_float: number;
};

/**
 * 按北京自然日算极值。
 * 多实例时按 terminal_id+day 各自算净值回撤，再按日取最差/最高，避免不同账户净值串在一起。
 */
async function loadDayEquityExtremes(
  env: Env,
  from: number,
  to: number,
  opts: { terminalId?: string; groupId?: string } = {},
): Promise<Map<string, DayExtreme>> {
  let where = ` WHERE s.ts >= ? AND s.ts <= ?`;
  const binds: unknown[] = [from, to];
  if (opts.terminalId) {
    where += ` AND s.terminal_id = ?`;
    binds.push(opts.terminalId);
  }
  if (opts.groupId) {
    where += ` AND EXISTS (SELECT 1 FROM terminals x WHERE x.terminal_id = s.terminal_id AND x.group_id = ?)`;
    binds.push(opts.groupId);
  }

  try {
    const rows = await env.DB.prepare(
      `WITH snaps AS (
         SELECT ${SQL_BJ_DAY_S} AS day,
                s.terminal_id AS terminal_id,
                s.ts AS ts,
                s.equity AS equity,
                s.floating_pl AS floating_pl
         FROM snapshots s${where}
       ),
       marked AS (
         SELECT day, terminal_id, equity, floating_pl,
                FIRST_VALUE(equity) OVER (
                  PARTITION BY terminal_id, day ORDER BY ts
                ) AS start_eq,
                MAX(equity) OVER (
                  PARTITION BY terminal_id, day ORDER BY ts
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS peak_eq
         FROM snaps
       ),
       per_term AS (
         SELECT day, terminal_id,
                COALESCE(MAX(equity - start_eq), 0) AS max_equity_up,
                COALESCE(MAX(peak_eq - equity), 0) AS max_equity_dd,
                COALESCE(MAX(floating_pl), 0) AS max_float,
                COALESCE(MIN(floating_pl), 0) AS min_float
         FROM marked
         GROUP BY day, terminal_id
       )
       SELECT day,
              MAX(max_equity_up) AS max_equity_up,
              MAX(max_equity_dd) AS max_equity_dd,
              MAX(max_float) AS max_float,
              MIN(min_float) AS min_float
       FROM per_term
       GROUP BY day`,
    )
      .bind(...binds)
      .all<DayExtreme & { day: string }>();

    return new Map(
      (rows.results || []).map((r) => [
        r.day,
        {
          max_equity_up: Number(r.max_equity_up || 0),
          max_equity_dd: Number(r.max_equity_dd || 0),
          max_float: Number(r.max_float || 0),
          min_float: Number(r.min_float || 0),
        },
      ]),
    );
  } catch {
    // 极旧 SQLite 无窗口函数时退化为当日浮盈高低
    const rows = await env.DB.prepare(
      `SELECT ${SQL_BJ_DAY_S} AS day,
              MAX(s.floating_pl) AS max_float,
              MIN(s.floating_pl) AS min_float
       FROM snapshots s${where}
       GROUP BY 1`,
    )
      .bind(...binds)
      .all<{ day: string; max_float: number; min_float: number }>();

    return new Map(
      (rows.results || []).map((r) => [
        r.day,
        {
          max_equity_up: 0,
          max_equity_dd: 0,
          max_float: Number(r.max_float || 0),
          min_float: Number(r.min_float || 0),
        },
      ]),
    );
  }
}

function finalizeDayRow(
  day: string,
  dayPnl: number,
  trades: number,
  maxTrade: number,
  minTrade: number,
  extreme: DayExtreme | undefined,
  running: number,
): DailyPnlRow {
  const maxFloat = extreme ? Number(extreme.max_float || 0) : 0;
  const minFloat = extreme ? Number(extreme.min_float || 0) : 0;
  const maxEquityUp = extreme ? Number(extreme.max_equity_up || 0) : 0;
  // 日历「最大浮亏」与卡片一致：取当日最低浮盈的绝对值（含 EA 每秒采样写入的 daily_float_min）
  const maxFloatLoss = Math.abs(Math.min(0, minFloat, minTrade));
  return {
    day,
    pnl: dayPnl,
    cumulative: running,
    trades,
    max_profit: Math.max(0, maxEquityUp, maxFloat, maxTrade),
    max_drawdown: maxFloatLoss,
  };
}

async function mergeEaDailyFloatMins(
  env: Env,
  extremeMap: Map<string, DayExtreme>,
  opts: { terminalId?: string; groupId?: string } = {},
): Promise<void> {
  let where = ` WHERE 1=1`;
  const binds: unknown[] = [];
  if (opts.terminalId) {
    where += ` AND terminal_id = ?`;
    binds.push(opts.terminalId);
  }
  if (opts.groupId) {
    where += ` AND EXISTS (SELECT 1 FROM terminals x WHERE x.terminal_id = daily_float_min.terminal_id AND x.group_id = ?)`;
    binds.push(opts.groupId);
  }
  try {
    const rows = await env.DB.prepare(
      `SELECT day, MIN(min_floating) AS min_floating
       FROM daily_float_min${where}
       GROUP BY day`,
    )
      .bind(...binds)
      .all<{ day: string; min_floating: number }>();
    for (const r of rows.results || []) {
      const day = String(r.day || "");
      if (!day) continue;
      const eaMin = Number(r.min_floating || 0);
      const cur = extremeMap.get(day);
      if (!cur) {
        extremeMap.set(day, {
          max_equity_up: 0,
          max_equity_dd: 0,
          max_float: 0,
          min_float: eaMin,
        });
      } else {
        cur.min_float = Math.min(Number(cur.min_float || 0), eaMin);
      }
    }
  } catch {
    /* table may not exist yet */
  }

  // 当天再合并 terminals.today_min_floating_pl（心跳刚写入、日历表尚未刷到时）
  if (opts.terminalId) {
    try {
      const ts = nowSec();
      const dayKey = beijingDayKeyFromSec(ts);
      const dayStart = beijingDayStartSec(ts);
      const row = await env.DB.prepare(
        `SELECT COALESCE(today_min_floating_pl, 0) AS tmn, COALESCE(today_min_day, 0) AS tday
         FROM terminals WHERE terminal_id = ?`,
      )
        .bind(opts.terminalId)
        .first<{ tmn: number; tday: number }>();
      if (row && Number(row.tday) === dayStart) {
        const eaMin = Number(row.tmn || 0);
        const cur = extremeMap.get(dayKey);
        if (!cur) {
          extremeMap.set(dayKey, {
            max_equity_up: 0,
            max_equity_dd: 0,
            max_float: 0,
            min_float: eaMin,
          });
        } else {
          cur.min_float = Math.min(Number(cur.min_float || 0), eaMin);
        }
      }
    } catch {
      /* ignore */
    }
  }
}

/** 与管理端 /api/v1/pnl 同一套日汇总（含当日高低回撤），避免分享页各算各的 */
export async function buildTerminalDailyPnl(
  env: Env,
  terminalId: string,
  from: number,
  to: number,
): Promise<{ daily: DailyPnlRow[]; total_pnl: number }> {
  const daily = await env.DB.prepare(
    `SELECT ${SQL_BJ_DAY_T} AS day,
            COALESCE(SUM(t.profit + t.commission + t.swap),0) AS pnl,
            COUNT(*) AS trades,
            MAX(t.profit + t.commission + t.swap) AS max_trade,
            MIN(t.profit + t.commission + t.swap) AS min_trade
     FROM trades t
     WHERE t.terminal_id = ? AND t.ts >= ? AND t.ts <= ?
     GROUP BY 1 ORDER BY 1`,
  )
    .bind(terminalId, from, to)
    .all<{
      day: string;
      pnl: number;
      trades: number;
      max_trade: number;
      min_trade: number;
    }>();

  const extremeMap = await loadDayEquityExtremes(env, from, to, { terminalId });
  await mergeEaDailyFloatMins(env, extremeMap, { terminalId });
  const days = [...(daily.results || [])];

  for (const [day] of extremeMap) {
    if (!days.some((d) => d.day === day)) {
      days.push({ day, pnl: 0, trades: 0, max_trade: 0, min_trade: 0 });
    }
  }
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  let running = 0;
  const rows: DailyPnlRow[] = days.map((d) => {
    const dayPnl = Number(d.pnl || 0);
    running += dayPnl;
    return finalizeDayRow(
      d.day,
      dayPnl,
      Number(d.trades || 0),
      Number(d.max_trade || 0),
      Number(d.min_trade || 0),
      extremeMap.get(d.day),
      running,
    );
  });

  return { daily: rows, total_pnl: running };
}

/** 分组 / 全站日汇总（日历格子仍用当日 pnl，不用累计） */
export async function buildScopedDailyPnl(
  env: Env,
  from: number,
  to: number,
  opts: { groupId?: string } = {},
): Promise<{ daily: DailyPnlRow[]; monthly: { month: string; pnl: number; trades: number }[]; total_pnl: number }> {
  let where = ` WHERE t.ts >= ? AND t.ts <= ?`;
  const binds: unknown[] = [from, to];
  if (opts.groupId) {
    where += ` AND EXISTS (SELECT 1 FROM terminals x WHERE x.terminal_id = t.terminal_id AND x.group_id = ?)`;
    binds.push(opts.groupId);
  }

  const daily = await env.DB.prepare(
    `SELECT ${SQL_BJ_DAY_T} AS day,
            COALESCE(SUM(t.profit + t.commission + t.swap),0) AS pnl,
            COUNT(*) AS trades,
            MAX(t.profit + t.commission + t.swap) AS max_trade,
            MIN(t.profit + t.commission + t.swap) AS min_trade
     FROM trades t${where}
     GROUP BY 1 ORDER BY 1`,
  )
    .bind(...binds)
    .all<{
      day: string;
      pnl: number;
      trades: number;
      max_trade: number;
      min_trade: number;
    }>();

  const monthly = await env.DB.prepare(
    `SELECT ${SQL_BJ_MONTH_T} AS month,
            COALESCE(SUM(t.profit + t.commission + t.swap),0) AS pnl,
            COUNT(*) AS trades
     FROM trades t${where}
     GROUP BY 1 ORDER BY 1`,
  )
    .bind(...binds)
    .all<{ month: string; pnl: number; trades: number }>();

  const extremeMap = await loadDayEquityExtremes(env, from, to, { groupId: opts.groupId });
  await mergeEaDailyFloatMins(env, extremeMap, { groupId: opts.groupId });
  const days = [...(daily.results || [])];
  for (const [day] of extremeMap) {
    if (!days.some((d) => d.day === day)) {
      days.push({ day, pnl: 0, trades: 0, max_trade: 0, min_trade: 0 });
    }
  }
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  let running = 0;
  const rows: DailyPnlRow[] = days.map((d) => {
    const dayPnl = Number(d.pnl || 0);
    running += dayPnl;
    return finalizeDayRow(
      d.day,
      dayPnl,
      Number(d.trades || 0),
      Number(d.max_trade || 0),
      Number(d.min_trade || 0),
      extremeMap.get(d.day),
      running,
    );
  });

  return {
    daily: rows,
    monthly: monthly.results || [],
    total_pnl: running,
  };
}
