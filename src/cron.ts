import type { Env } from "./types";
import { nowSec } from "./types";
import { getAlertSettings } from "./settings";
import { insertAlert } from "./ingest";

/** 严格按「超时判定（秒）」设置，最少 60 秒 */
export function offlineGapSeconds(offlineAfter: number): number {
  return Math.max(60, Number(offlineAfter) || 180);
}

export function liveOnline(lastSeen: number, offlineAfter: number, now = nowSec()): boolean {
  if (!lastSeen) return false;
  return now - lastSeen <= offlineGapSeconds(offlineAfter);
}

export async function runOfflineCheck(env: Env): Promise<void> {
  const settings = await getAlertSettings(env);
  const fallback = offlineGapSeconds(settings.offline_after_seconds || Number(env.OFFLINE_AFTER_SECONDS || 180));
  const ts = nowSec();
  const rows = await env.DB.prepare(
    `SELECT terminal_id, computer_id, computer_name, account, last_seen, report_interval, online
     FROM terminals WHERE last_seen IS NOT NULL`,
  ).all<{
    terminal_id: string;
    computer_id: string;
    computer_name: string;
    account: string;
    last_seen: number;
    report_interval: number;
    online: number;
  }>();

  for (const t of rows.results || []) {
    const isOnline = liveOnline(t.last_seen || 0, fallback, ts);
    if (!isOnline && t.online) {
      await env.DB.prepare(`UPDATE terminals SET online = 0, updated_at = ? WHERE terminal_id = ?`)
        .bind(ts, t.terminal_id)
        .run();
      await env.DB.prepare(`UPDATE eas SET status = 'offline', updated_at = ? WHERE terminal_id = ?`)
        .bind(ts, t.terminal_id)
        .run();
      const ago = ts - (t.last_seen || 0);
      const detail = `超过 ${fallback} 秒未收到心跳（电脑 ${t.computer_name || t.computer_id || "-"} / 账号 ${t.account || "-"}）`;
      if (settings.alert_timeout) {
        await insertAlert(env, {
          terminalId: t.terminal_id,
          computerId: t.computer_id,
          type: "timeout",
          severity: "warn",
          detail,
        });
      }
      console.log(`[offline] timeout terminal=${t.terminal_id} ago=${ago}s threshold=${fallback}s`);
    } else if (isOnline && !t.online) {
      await env.DB.prepare(`UPDATE terminals SET online = 1, updated_at = ? WHERE terminal_id = ?`)
        .bind(ts, t.terminal_id)
        .run();
      console.log(`[offline] back online terminal=${t.terminal_id}`);
    }
  }

  const staleEas = await env.DB.prepare(
    `SELECT ea_id, terminal_id, computer_id, ea_name, magic, last_heartbeat, status
     FROM eas WHERE last_heartbeat IS NOT NULL AND status != 'offline'`,
  ).all<{
    ea_id: string;
    terminal_id: string;
    computer_id: string;
    ea_name: string;
    magic: number;
    last_heartbeat: number;
    status: string;
  }>();
  for (const ea of staleEas.results || []) {
    if (ts - (ea.last_heartbeat || 0) > fallback) {
      await env.DB.prepare(`UPDATE eas SET status = 'offline', updated_at = ? WHERE ea_id = ?`)
        .bind(ts, ea.ea_id)
        .run();
      if (settings.alert_ea_timeout) {
        const detail = `EA「${ea.ea_name}」magic=${ea.magic} 超过 ${fallback} 秒未心跳`;
        await insertAlert(env, {
          terminalId: ea.terminal_id,
          eaId: ea.ea_id,
          computerId: ea.computer_id,
          type: "ea_timeout",
          severity: "warn",
          detail,
        });
      }
      console.log(`[offline] ea_timeout ea=${ea.ea_id}`);
    }
  }

  // 清理不必每次跑；约每小时一次（检查间隔 60 秒，窗口留宽一点）
  if (ts % 3600 < 90) {
    await env.DB.prepare(`DELETE FROM snapshots WHERE ts < ?`).bind(ts - 14 * 86400).run();
    await env.DB.prepare(`DELETE FROM logs WHERE ts < ?`).bind(ts - 30 * 86400).run();
  }
}
