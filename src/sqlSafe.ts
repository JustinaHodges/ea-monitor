/** SQL 安全辅助：值一律 bind；标识符只用白名单常量。 */

/** 转义 LIKE 通配符，避免用户输入 %/_ 扩大匹配面（仍须 bind + ESCAPE） */
export function likeEscape(raw: string): string {
  return String(raw).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** 有限数字，否则回退（空字符串不能当 0：Number("")===0 会把缺省 to 弄成 ts<=0） */
export function finiteNumber(raw: unknown, fallback: number): number {
  if (raw === "" || raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 整数夹取 */
export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(finiteNumber(raw, fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 终端扩展列：整句 DDL 常量，禁止拼接用户输入 */
export const TERMINAL_ALERT_COLUMN_DDL = [
  `ALTER TABLE terminals ADD COLUMN float_profit_alert REAL DEFAULT 0`,
  `ALTER TABLE terminals ADD COLUMN float_loss_alert REAL DEFAULT 0`,
  `ALTER TABLE terminals ADD COLUMN float_profit_latched INTEGER DEFAULT 0`,
  `ALTER TABLE terminals ADD COLUMN float_loss_latched INTEGER DEFAULT 0`,
  `ALTER TABLE terminals ADD COLUMN display_unit TEXT DEFAULT ''`,
  `ALTER TABLE terminals ADD COLUMN share_intro TEXT DEFAULT ''`,
  `ALTER TABLE terminals ADD COLUMN share_contact TEXT DEFAULT ''`,
  `ALTER TABLE terminals ADD COLUMN broker_gmt_offset INTEGER DEFAULT 0`,
  `ALTER TABLE terminals ADD COLUMN quote_digits INTEGER DEFAULT 2`,
  `ALTER TABLE terminals ADD COLUMN min_floating_pl REAL DEFAULT 0`,
  `ALTER TABLE terminals ADD COLUMN today_min_floating_pl REAL DEFAULT 0`,
  `ALTER TABLE terminals ADD COLUMN today_min_day INTEGER DEFAULT 0`,
  `ALTER TABLE terminals ADD COLUMN backfill_done INTEGER DEFAULT 0`,
] as const;

export const DAILY_FLOAT_MIN_DDL = `CREATE TABLE IF NOT EXISTS daily_float_min (
  terminal_id TEXT NOT NULL,
  day TEXT NOT NULL,
  min_floating REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (terminal_id, day)
)` as const;

export async function ensureTerminalAlertColumns(env: { DB: D1Database }): Promise<void> {
  for (const ddl of TERMINAL_ALERT_COLUMN_DDL) {
    try {
      await env.DB.prepare(ddl).run();
    } catch {
      /* column already exists */
    }
  }
  for (const ddl of [
    `ALTER TABLE positions_latest ADD COLUMN spread REAL DEFAULT 0`,
  ] as const) {
    try {
      await env.DB.prepare(ddl).run();
    } catch {
      /* column already exists */
    }
  }
  try {
    await env.DB.prepare(DAILY_FLOAT_MIN_DDL).run();
  } catch {
    /* ok */
  }
}
