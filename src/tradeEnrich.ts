import type { Env } from "./types";

type TradeRow = Record<string, unknown> & {
  terminal_id?: string;
  symbol?: string;
  entry?: string;
  volume?: number;
  price?: number;
  ts?: number;
  price_open?: number;
  comment?: string;
};

/** Attach open price + open comment to close rows by matching prior IN deals. */
export async function withOpenPrices(
  env: Env,
  rows: TradeRow[],
  fallbackTerminalId = "",
): Promise<TradeRow[]> {
  if (!rows.length) return rows;

  const need = rows.filter((r) => {
    const e = String(r.entry || "").toLowerCase();
    return e === "out" || e === "inout" || e === "";
  });
  if (!need.length) {
    return rows.map((r) => ({
      ...r,
      price_open:
        Number(r.price_open || 0) ||
        (String(r.entry || "").toLowerCase() === "in" ? Number(r.price || 0) : 0),
    }));
  }

  const byTerm = new Map<string, TradeRow[]>();
  for (const r of need) {
    const tid = String(r.terminal_id || fallbackTerminalId || "");
    if (!tid) continue;
    if (!byTerm.has(tid)) byTerm.set(tid, []);
    byTerm.get(tid)!.push(r);
  }

  const openByTerm = new Map<string, TradeRow[]>();
  for (const [tid, list] of byTerm) {
    const minTs = Math.min(...list.map((r) => Number(r.ts || 0))) - 90 * 86400;
    const maxTs = Math.max(...list.map((r) => Number(r.ts || 0)));
    const opens = await env.DB.prepare(
      `SELECT symbol, volume, price, ts, comment FROM trades
       WHERE terminal_id = ? AND lower(COALESCE(entry, '')) = 'in'
         AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`,
    )
      .bind(tid, Math.max(0, minTs), maxTs)
      .all<TradeRow>();
    openByTerm.set(tid, opens.results || []);
  }

  return rows.map((r) => {
    const e = String(r.entry || "").toLowerCase();
    if (e === "in") {
      return { ...r, price_open: Number(r.price_open || r.price || 0) };
    }

    const tid = String(r.terminal_id || fallbackTerminalId || "");
    const opens = openByTerm.get(tid) || [];
    const ts = Number(r.ts || 0);
    const sym = String(r.symbol || "");
    const vol = Number(r.volume || 0);
    let best: TradeRow | null = null;
    let bestScore = -Infinity;
    for (const o of opens) {
      if (String(o.symbol || "") !== sym) continue;
      const ots = Number(o.ts || 0);
      if (ots > ts) continue;
      const dv = Math.abs(Number(o.volume || 0) - vol);
      const score = (dv < 1e-8 ? 1e15 : 1e12) - (ts - ots) - dv * 1e6;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }

    const priceOpen =
      Number(r.price_open || 0) > 0 ? Number(r.price_open) : best ? Number(best.price || 0) : 0;
    const closeComment = String(r.comment || "").trim();
    const openComment = best ? String(best.comment || "").trim() : "";
    // Prefer open remark (SJL/QQ); close deals are often empty or [tp]
    const remark = openComment || closeComment || "";

    return {
      ...r,
      price_open: priceOpen,
      comment: remark,
    };
  });
}
