import type { Env } from "./types";

export type AlertType =
  | "timeout"
  | "ea_timeout"
  | "ea_error"
  | "log_error"
  | "float_profit"
  | "float_loss"
  | "test";

const TYPE_TITLE: Record<string, string> = {
  timeout: "终端超时未上报",
  ea_timeout: "EA 超时未心跳",
  ea_error: "EA 错误回报",
  log_error: "日志错误 / Fatal",
  float_profit: "浮盈达标",
  float_loss: "浮亏达标",
  test: "测试通知",
};

export type TerminalAlertCtx = {
  terminal_id: string;
  name: string;
  note: string;
  computer_id: string;
  computer_name: string;
  account: string;
  account_name: string;
  broker: string;
  server: string;
  group_name: string;
};

export function alertTypeTitle(type: string): string {
  return TYPE_TITLE[type] || type || "告警";
}

export function formatBeijingTime(tsSec = Math.floor(Date.now() / 1000)): string {
  const d = new Date(tsSec * 1000);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export async function loadTerminalAlertCtx(env: Env, terminalId: string): Promise<TerminalAlertCtx> {
  const row = await env.DB.prepare(
    `SELECT t.terminal_id, t.name, t.note, t.computer_id, t.computer_name,
            t.account, t.account_name, t.broker, t.server,
            COALESCE(g.name, '') AS group_name
     FROM terminals t
     LEFT JOIN groups g ON g.id = t.group_id
     WHERE t.terminal_id = ?`,
  )
    .bind(terminalId)
    .first<{
      terminal_id: string;
      name: string | null;
      note: string | null;
      computer_id: string | null;
      computer_name: string | null;
      account: string | null;
      account_name: string | null;
      broker: string | null;
      server: string | null;
      group_name: string | null;
    }>();

  return {
    terminal_id: row?.terminal_id || terminalId,
    name: row?.name || "",
    note: row?.note || "",
    computer_id: row?.computer_id || "",
    computer_name: row?.computer_name || "",
    account: row?.account || "",
    account_name: row?.account_name || "",
    broker: row?.broker || "",
    server: row?.server || "",
    group_name: row?.group_name || "",
  };
}

function dash(v: string | undefined | null, fallback = "未填写"): string {
  const s = String(v || "").trim();
  return s || fallback;
}

/** 统一告警文案：分组 / 实例ID / 情况回报 */
export function formatAlertMessage(opts: {
  type: string;
  detail: string;
  ctx?: Partial<TerminalAlertCtx>;
  tsSec?: number;
}): string {
  const ctx = opts.ctx || {};
  const title = alertTypeTitle(opts.type);
  const remark = dash(ctx.name || ctx.note, "未命名");
  const group = dash(ctx.group_name, "未分组");
  const computer = dash(ctx.computer_name || ctx.computer_id, "-");
  const account = dash(ctx.account, "-");
  const accountName = String(ctx.account_name || "").trim();
  const broker = String(ctx.broker || "").trim();
  const server = String(ctx.server || "").trim();
  const brokerLine = [broker, server].filter(Boolean).join(" / ");

  const lines = [
    `【四季常春监控】${title}`,
    `分组：${group}`,
    `实例ID：${dash(ctx.terminal_id, "-")}`,
    `备注名：${remark}`,
    `电脑：${computer}`,
    `账号：${account}${accountName ? `（${accountName}）` : ""}`,
  ];
  if (brokerLine) lines.push(`券商：${brokerLine}`);
  lines.push(`情况：${String(opts.detail || "").trim() || "-"}`);
  lines.push(`时间：${formatBeijingTime(opts.tsSec)}（北京时间）`);
  lines.push(`开发者QQ:3271663089`);
  return lines.join("\n");
}

export async function buildAlertMessage(
  env: Env,
  opts: { terminalId: string; type: string; detail: string; computerId?: string },
): Promise<string> {
  const ctx = await loadTerminalAlertCtx(env, opts.terminalId);
  if (opts.computerId && !ctx.computer_id) ctx.computer_id = opts.computerId;
  return formatAlertMessage({ type: opts.type, detail: opts.detail, ctx });
}

export function sampleAlertMessage(): string {
  return formatAlertMessage({
    type: "test",
    detail: "这是一条测试通知。若收到本条，说明 Webhook 配置正常。祝各位交易者一路四季常春。",
    ctx: {
      terminal_id: "示例实例ID",
      name: "示例终端",
      group_name: "示例分组",
      computer_id: "HOME-PC",
      computer_name: "家里电脑",
      account: "12345678",
      account_name: "Demo",
      broker: "示例券商",
      server: "Demo-Server",
    },
  });
}
