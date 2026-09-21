/**
 * 持仓 / 挂单表格模块（站内实例页与分享页共用）
 */
(function (global) {
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtN(n, d = 2) {
    const v = Number(n || 0);
    return v.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function pnlClass(n) {
    const v = Number(n || 0);
    if (v > 0) return "pos";
    if (v < 0) return "neg";
    return "";
  }

  function sideLabel(side) {
    const s = String(side || "").toLowerCase();
    if (s === "buy" || s === "long") return "BUY";
    if (s === "sell" || s === "short") return "SELL";
    return side || "-";
  }

  /**
   * 成交明细用「持仓方向」：平仓单在 MT5 里成交方向与持仓相反
   * （平多用 SELL 成交、平空用 BUY 成交），直接显示会看起来盈亏反了。
   */
  function positionSideLabel(side, entry) {
    const e = String(entry || "").toLowerCase();
    const isClose = e === "out" || e === "inout" || e === "";
    const s = String(side || "").toLowerCase();
    let dir = s;
    if (isClose) {
      if (s === "buy" || s === "long") dir = "sell";
      else if (s === "sell" || s === "short") dir = "buy";
    }
    return sideLabel(dir);
  }

  /** MT5 成交方向：入场/出场（开仓盈利通常为 0） */
  function entryLabel(entry) {
    const e = String(entry || "").toLowerCase();
    if (e === "in") return "开仓";
    if (e === "out") return "平仓";
    if (e === "inout") return "反手";
    // 旧数据 / MT4 仅上报平仓，空值按平仓看
    return "平仓";
  }

  function moneyTxt(n, d = 2) {
    const v = Number(n || 0);
    const sign = v > 0 ? "+" : "";
    return `${sign}${fmtN(v, d)}`;
  }

  /**
   * 近似 MT5 成交列；可关成交号/手续费/库存费
   */
  function renderMt5DealsTable(el, rows, opts) {
    if (!el) return;
    const {
      fmtTime = (v) => String(v ?? "-"),
      fmtServerTime = null,
      priceDigits = 2,
      moneyDigits = 2,
      showTicket = false,
      showCommission = false,
      showSwap = false,
      emptyText = "暂无成交",
    } = opts || {};
    if (!rows || !rows.length) {
      el.innerHTML = `<p class="muted">${escapeHtml(emptyText)}</p>`;
      return;
    }
    const pd = Math.max(0, Math.min(8, Number(priceDigits) || 2));
    const md = Math.max(0, Math.min(8, Number(moneyDigits) || 2));
    // 不显示手续费/库存费时，盈利列用净额（含手续费+库存费）
    const profitNet = !showCommission && !showSwap;
    const head = [
      "<th>北京时间</th>",
      fmtServerTime ? "<th>服务商时间</th>" : "",
      showTicket ? "<th>成交号</th>" : "",
      "<th>品种</th>",
      "<th>类型</th>",
      "<th>手数</th>",
      "<th>开仓价位</th>",
      "<th>开平价位</th>",
      showCommission ? "<th>手续费</th>" : "",
      showSwap ? "<th>库存费</th>" : "",
      "<th>盈利</th>",
      "<th>备注</th>",
    ]
      .filter(Boolean)
      .join("");
    const body = rows
      .map((r) => {
        const profit = Number(r.profit || 0);
        const commission = Number(r.commission || 0);
        const swap = Number(r.swap || 0);
        const profitShow = profitNet ? profit + commission + swap : profit;
        const openPx = Number(r.price_open || 0);
        const closePx = Number(r.price || 0);
        const cells = [
          `<td>${escapeHtml(fmtTime(r.ts))}</td>`,
          fmtServerTime ? `<td>${escapeHtml(fmtServerTime(r.ts))}</td>` : "",
          showTicket ? `<td>${escapeHtml(r.ticket || "-")}</td>` : "",
          `<td>${escapeHtml(r.symbol || "-")}</td>`,
          `<td>${escapeHtml(positionSideLabel(r.side, r.entry))}</td>`,
          `<td>${fmtN(r.volume, 2)}</td>`,
          `<td>${openPx > 0 ? fmtN(openPx, pd) : "—"}</td>`,
          `<td>${closePx > 0 ? fmtN(closePx, pd) : "—"}</td>`,
          showCommission ? `<td class="${pnlClass(commission)}">${moneyTxt(commission, md)}</td>` : "",
          showSwap ? `<td class="${pnlClass(swap)}">${moneyTxt(swap, md)}</td>` : "",
          `<td class="${pnlClass(profitShow)}">${moneyTxt(profitShow, md)}</td>`,
          `<td>${escapeHtml(r.comment || "-")}</td>`,
        ]
          .filter(Boolean)
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");
    el.innerHTML = `<table class="mt5-deals-table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  function renderBooksTable(el, rows, emptyText, priceDigits = 2) {
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = `<div class="share-books-empty">${escapeHtml(emptyText)}</div>`;
      return;
    }
    const pd = Math.max(0, Math.min(8, Number(priceDigits) || 2));
    const body = rows
      .map((r) => {
        const sl = Number(r.sl || 0);
        const tp = Number(r.tp || 0);
        return `<tr>
      <td>${escapeHtml(r.symbol || "-")}</td>
      <td>${escapeHtml(sideLabel(r.side))}</td>
      <td>${fmtN(r.volume, 2)}</td>
      <td>${fmtN(r.price_open, pd)}</td>
      <td>${fmtN(r.price_current, pd)}</td>
      <td class="${pnlClass(r.profit)}">${fmtN(r.profit)}</td>
      <td>${sl > 0 ? fmtN(sl, pd) : "—"}</td>
      <td>${tp > 0 ? fmtN(tp, pd) : "—"}</td>
    </tr>`;
      })
      .join("");
    el.innerHTML = `<table>
    <thead><tr>
      <th>品种</th><th>方向</th><th>手数</th><th>开仓价</th><th>现价</th><th>盈亏</th><th>止损</th><th>止盈</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
  }

  function renderBooksPanel(opts) {
    const {
      root,
      totalEl,
      posCountEl,
      pendingCountEl,
      posTableEl,
      pendingTableEl,
      positions = [],
      pending = [],
      showPending = true,
      pendingClosedText = "未开放挂单明细",
      quoteDigits = 2,
    } = opts || {};

    root?.classList.remove("hidden");

    const pos = positions || [];
    const pend = showPending ? pending || [] : [];
    const q = Number(quoteDigits);
    const pd = q === 3 || q === 4 || q === 5 ? q : 2;

    if (posCountEl) posCountEl.textContent = pos.length ? `${pos.length} 笔` : "";
    if (pendingCountEl) {
      pendingCountEl.textContent = showPending ? (pend.length ? `${pend.length} 笔` : "") : "";
    }
    if (totalEl) {
      if (!showPending) {
        totalEl.textContent = pos.length ? `持仓 ${pos.length} · 挂单未开放` : "挂单未开放";
      } else {
        totalEl.textContent =
          pos.length || pend.length
            ? `持仓 ${pos.length} · 挂单 ${pend.length}`
            : "暂无持仓与挂单";
      }
    }

    renderBooksTable(posTableEl, pos, "当前没有持仓", pd);
    renderBooksTable(
      pendingTableEl,
      pend,
      showPending ? "当前没有挂单" : pendingClosedText,
      pd,
    );
  }

  global.BooksUI = {
    sideLabel,
    positionSideLabel,
    entryLabel,
    renderBooksTable,
    renderBooksPanel,
    renderMt5DealsTable,
  };
})(typeof window !== "undefined" ? window : globalThis);
