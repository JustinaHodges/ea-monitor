import { nowSec } from "./types";

/** SQLite：把 unix 秒转成北京日历日 `YYYY-MM-DD` */
export const SQL_BJ_DAY = `date(ts, 'unixepoch', '+8 hours')`;
export const SQL_BJ_DAY_T = `date(t.ts, 'unixepoch', '+8 hours')`;
export const SQL_BJ_DAY_S = `date(s.ts, 'unixepoch', '+8 hours')`;
export const SQL_BJ_MONTH_T = `strftime('%Y-%m', t.ts, 'unixepoch', '+8 hours')`;

/** 当前北京时间的自然日 0 点（unix 秒） */
export function beijingDayStartSec(now = nowSec()): number {
  const key = beijingDayKeyFromSec(now);
  return Math.floor(Date.parse(`${key}T00:00:00+08:00`) / 1000);
}

export function beijingDayKeyFromSec(sec: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(sec * 1000));
}

/** 当前北京自然月 1 号 0 点 */
export function beijingMonthStartSec(now = nowSec()): number {
  const ym = beijingDayKeyFromSec(now).slice(0, 7);
  return Math.floor(Date.parse(`${ym}-01T00:00:00+08:00`) / 1000);
}
