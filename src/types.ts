export interface Env {
  DB: D1Database;
  LOGS?: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  NOTIFY_WEBHOOK?: string;
  OFFLINE_AFTER_SECONDS?: string;
  /** 1/true 开启域名授权校验 */
  LICENSE_ENFORCE?: string;
  /** 本安装包绑定的域名（打包时写入；访问 Host 必须一致） */
  LICENSE_DOMAIN?: string;
  /** 签发/校验授权码的密钥（按域名派生，写进客户包） */
  LICENSE_SECRET?: string;
}

export interface PositionPayload {
  ticket?: string | number;
  magic?: number;
  symbol?: string;
  kind?: string;
  side?: string;
  volume?: number;
  price_open?: number;
  price_current?: number;
  sl?: number;
  tp?: number;
  profit?: number;
  comment?: string;
  open_time?: number;
  /** 品种点差（点） */
  spread?: number;
}

export interface EaPayload {
  ea_name?: string;
  ea_version?: string;
  strategy_tag?: string;
  magic?: number;
  symbol?: string;
  timeframe?: string;
  started_at?: number;
  status?: string;
  last_error?: string;
  position_count?: number;
  pending_count?: number;
  floating_pl?: number;
}

export interface HeartbeatPayload {
  computer_id?: string;
  computer_name?: string;
  terminal_id?: string;
  platform?: string;
  mt_build?: number;
  broker?: string;
  server?: string;
  account?: string;
  account_name?: string;
  currency?: string;
  leverage?: number;
  report_interval?: number;
  /** 券商服务器相对 GMT 的秒差（TimeCurrent - TimeGMT） */
  broker_gmt_offset?: number;
  /** 图表品种报价小数位；不传时由服务端从持仓报价推断 */
  quote_digits?: number;
  /** EA 本地每秒采样：今日最低浮盈（可负） */
  today_min_floating?: number;
  /** EA 本地采样：启动以来最低浮盈（可负） */
  min_floating?: number;
  /** EA 完成本月+上月历史扫描后上报；无成交账户也可为 true，避免无限强制补传 */
  backfill_done?: boolean | number | string;
  balance?: number;
  equity?: number;
  floating_pl?: number;
  margin?: number;
  free_margin?: number;
  margin_level?: number;
  last_error?: string;
  positions?: PositionPayload[];
  pending?: PositionPayload[];
  eas?: EaPayload[];
}

export interface TradePayload {
  computer_id?: string;
  terminal_id?: string;
  account?: string;
  ea_id?: string;
  ea_name?: string;
  ticket?: string | number;
  magic?: number;
  symbol?: string;
  side?: string;
  entry?: string;
  volume?: number;
  price?: number;
  sl?: number;
  tp?: number;
  profit?: number;
  commission?: number;
  swap?: number;
  comment?: string;
  ts?: number;
}

export interface LogPayload {
  computer_id?: string;
  terminal_id?: string;
  ea_id?: string;
  ea_name?: string;
  magic?: number;
  level?: string;
  message?: string;
  ts?: number;
}

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function clampStr(v: unknown, max = 200): string {
  return String(v ?? "").slice(0, max);
}

export function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function eaId(terminalId: string, magic: number, symbol: string, eaName: string): string {
  return `${terminalId}|${magic}|${symbol || "-"}|${eaName || "unknown"}`;
}
