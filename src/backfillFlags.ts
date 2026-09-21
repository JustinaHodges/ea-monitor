import { ensureTerminalAlertColumns } from "./sqlSafe";
import type { Env, HeartbeatPayload } from "./types";
import { nowSec } from "./types";

/** �½�ʵ������ǿ�Ʋ����Ŀ����ڣ��룩������ʹ 0 �ɽ�Ҳ����ˢ force_backfill */
const BACKFILL_FORCE_MAX_AGE_SEC = 2 * 3600;

function truthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * ������Ӧ��ĳɽ�/������־��
 * �޳ɽ��˻���һֱ force_backfill��EA ��ÿ��������ʷɨ�貢ˢ����
 * �� EA �ϱ� backfill_done���򽨵����������ں�ֹͣǿ�Ʋ�����
 */
export async function buildHeartbeatTradeFlags(
  env: Env,
  terminalId: string,
  payload: HeartbeatPayload,
  lastSeenBefore: number,
): Promise<{
  first_on_server: boolean;
  trade_count: number;
  last_seen_before: number;
  last_trade_ts: number;
  last_trade_ticket: string;
  resume_from_ts: number;
  force_backfill: boolean;
}> {
  await ensureTerminalAlertColumns(env);
  const ts = nowSec();

  const tradeCountRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM trades WHERE terminal_id = ?`)
    .bind(terminalId)
    .first<{ c: number }>();
  const tradeCount = Number(tradeCountRow?.c || 0);
  const lastTrade = await env.DB.prepare(
    `SELECT ticket, ts FROM trades WHERE terminal_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1`,
  )
    .bind(terminalId)
    .first<{ ticket: string; ts: number }>();

  const term = await env.DB.prepare(
    `SELECT COALESCE(backfill_done, 0) AS bd, COALESCE(created_at, 0) AS ca
     FROM terminals WHERE terminal_id = ?`,
  )
    .bind(terminalId)
    .first<{ bd: number; ca: number }>();

  let backfillDone = Number(term?.bd || 0) === 1;
  const createdAt = Number(term?.ca || 0);

  if (truthyFlag(payload.backfill_done) && !backfillDone) {
    await env.DB.prepare(`UPDATE terminals SET backfill_done = 1, updated_at = ? WHERE terminal_id = ?`)
      .bind(ts, terminalId)
      .run();
    backfillDone = true;
  }

  if (tradeCount === 0 && !backfillDone && createdAt > 0 && ts - createdAt >= BACKFILL_FORCE_MAX_AGE_SEC) {
    await env.DB.prepare(`UPDATE terminals SET backfill_done = 1, updated_at = ? WHERE terminal_id = ?`)
      .bind(ts, terminalId)
      .run();
    backfillDone = true;
  }

  const needBackfill = tradeCount === 0 && !backfillDone;
  return {
    first_on_server: needBackfill,
    trade_count: tradeCount,
    last_seen_before: lastSeenBefore,
    last_trade_ts: Number(lastTrade?.ts || 0),
    last_trade_ticket: String(lastTrade?.ticket || ""),
    resume_from_ts: tradeCount === 0 ? 0 : Number(lastTrade?.ts || 0),
    force_backfill: needBackfill,
  };
}
