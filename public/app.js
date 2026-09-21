const $ = (id) => document.getElementById(id);

let state = {
  workspace: null,
  groups: [],
  selectedId: "",
  homeGroupFilter: "all",
  homeCards: [],
  pnlMonth: "",
  instMonth: "",
  pnlDaily: [],
  instDaily: [],
  collapsedGroups: {},
  posRows: [],
  tradeGroupId: "",
  tradeTerminalId: "",
  instDayKey: "",
  pnlDayKey: "",
  instQuoteDigits: 2,
};

async function api(path, opt = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
    ...opt,
  });
  if (res.status === 401) throw Object.assign(new Error("unauthorized"), { code: 401 });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/csv")) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(new Error(data.error || "request failed"), {
      code: res.status,
      data,
    });
    throw err;
  }
  return data;
}

function fmtN(n, d = 2) {
  const x = Number(n || 0);
  return x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 金额小数位自适应：默认至少 2 位，有更细精度则显示到最多 5 位 */
function moneyDec(n, maxD = 5) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 2;
  const max = Math.max(2, Math.min(8, Number(maxD) || 5));
  const factor = 10 ** max;
  let v = Math.round(Math.abs(x) * factor + Number.EPSILON);
  let d = max;
  while (d > 2 && v % 10 === 0) {
    v = Math.floor(v / 10);
    d -= 1;
  }
  return d;
}

/** 用实例设置的金额单位挂在数字后面；没设则不加 */
function ccySuffix(unit) {
  const u = String(unit || "").trim();
  return u ? ` <span class="ccy">${escapeHtml(u)}</span>` : "";
}

/** 按实例报价位数决定金额显示：2→2位，3→3位；5位外汇等默认按 2 位金额 */
function moneyDigitsFromQuote(quoteDigits, fallbackN) {
  const q = Number(quoteDigits);
  if (q === 3) return 3;
  if (q === 2) return 2;
  if (q === 4) return 4;
  if (fallbackN != null) return moneyDec(fallbackN);
  return 2;
}

function fmtMoney(n, unit, d) {
  const digits = d == null ? moneyDec(n) : d;
  return `${fmtN(n, digits)}${ccySuffix(unit)}`;
}

function fmtMoneyForInst(n, unit, quoteDigits) {
  return fmtMoney(n, unit, moneyDigitsFromQuote(quoteDigits, n));
}

/** 卡片中间大号浮盈：数字居中，单位贴右侧 */
function fmtFloatHero(n, unit, d) {
  const u = String(unit || "").trim();
  const digits = d == null ? moneyDec(n) : d;
  const num = `<span class="inst-float-num">${fmtN(n, digits)}</span>`;
  if (!u) return num;
  return `${num}<span class="ccy">${escapeHtml(u)}</span>`;
}

function fmtFloatHeroForInst(n, unit, quoteDigits) {
  return fmtFloatHero(n, unit, moneyDigitsFromQuote(quoteDigits, n));
}

function pnlClass(n) {
  const x = Number(n || 0);
  return x > 0 ? "pos" : x < 0 ? "neg" : "";
}

function fmtTs(sec) {
  if (!sec) return "-";
  return fmtBeijing(sec);
}

/** 统一按北京时间显示（与日切/统计一致，不跟浏览器或 VPS 本地时区） */
function fmtBeijing(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(n * 1000));
}

/** 券商服务器时间 = UTC 成交时刻 + 券商相对 GMT 偏移 */
function fmtBrokerServer(sec, offsetSec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const off = Number(offsetSec) || 0;
  if (!off) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date((n + off) * 1000));
}

function ago(sec) {
  if (!sec) return "从未上报";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function table(el, cols, rows, fmt = {}) {
  if (!rows.length) {
    el.innerHTML = `<p class="muted">暂无数据</p>`;
    return;
  }
  el.innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${(fmt[c.key] || ((v) => v ?? "-"))(r[c.key], r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function showGate(msg = "") {
  $("app").classList.add("hidden");
  $("license-gate")?.classList.add("hidden");
  $("gate").classList.remove("hidden");
  $("login-error").textContent = msg;
}

function showApp() {
  $("gate").classList.add("hidden");
  $("license-gate")?.classList.add("hidden");
  $("app").classList.remove("hidden");
}

function showLicenseGate(st) {
  $("app").classList.add("hidden");
  $("gate").classList.add("hidden");
  $("license-gate")?.classList.remove("hidden");
  const hostEl = $("license-host");
  if (hostEl) {
    const parts = [];
    if (st?.host) parts.push(`当前访问：${st.host}`);
    if (st?.reason) parts.push(st.reason);
    hostEl.textContent = parts.join(" · ") || "";
  }
  if ($("license-error")) $("license-error").textContent = "";
}

function setNav(name) {
  document.querySelectorAll(".site-nav .nav-link").forEach((b) => {
    const map = name === "instance" ? "instances" : name;
    b.classList.toggle("is-active", b.dataset.view === map);
  });
}

function openModal(title, bodyHtml, actionsHtml) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHtml;
  $("modal-actions").innerHTML = actionsHtml;
  $("modal").classList.remove("hidden");
  enhanceSelects($("modal"));
}

function closeModal() {
  $("modal").classList.add("hidden");
  document.querySelectorAll(".ui-select.is-open").forEach((el) => el.classList.remove("is-open"));
}

/** 站内同款确认框，替代浏览器原生 confirm */
function confirmModal(message, opts = {}) {
  const title = opts.title || "请确认";
  const okText = opts.okText || "确定";
  const cancelText = opts.cancelText || "取消";
  const danger = !!opts.danger;
  const body = `<p class="confirm-msg">${escapeHtml(String(message || "")).replace(/\n/g, "<br>")}</p>`;
  const actions = `
    <button type="button" class="btn btn-secondary" data-confirm-cancel>${escapeHtml(cancelText)}</button>
    <button type="button" class="btn ${danger ? "btn danger" : "btn-primary"}" data-confirm-ok>${escapeHtml(okText)}</button>`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      modal.removeEventListener("click", onModalClick, true);
      closeModal();
      resolve(!!ok);
    };
    const onModalClick = (ev) => {
      if (ev.target.closest("[data-confirm-ok]")) {
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);
        return;
      }
      if (ev.target.closest("[data-confirm-cancel]") || ev.target.matches("[data-close], .modal-backdrop")) {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    };
    const modal = $("modal");
    openModal(title, body, actions);
    modal.addEventListener("click", onModalClick, true);
  });
}

function enhanceSelects(root = document) {
  root.querySelectorAll("select:not([data-ui-select]):not([data-native])").forEach((sel) => {
    if (sel.closest(".ui-select")) return;
    sel.dataset.uiSelect = "1";
    const wrap = document.createElement("div");
    wrap.className = "ui-select";
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add("hidden");
    sel.tabIndex = -1;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ui-select-trigger";
    const label = document.createElement("span");
    label.className = "ui-select-label";
    const caret = document.createElement("span");
    caret.className = "caret";
    trigger.append(label, caret);

    const menu = document.createElement("div");
    menu.className = "ui-select-menu";

    const sync = () => {
      const opts = [...sel.options];
      menu.innerHTML = opts.map((o) =>
        `<button type="button" class="ui-select-option ${o.selected ? "is-active" : ""}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.textContent)}</button>`
      ).join("");
      const cur = sel.options[sel.selectedIndex];
      label.textContent = cur ? cur.textContent : "";
    };

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = wrap.classList.contains("is-open");
      document.querySelectorAll(".ui-select.is-open").forEach((el) => el.classList.remove("is-open"));
      if (!open) {
        sync();
        wrap.classList.add("is-open");
      }
    });

    menu.addEventListener("click", (e) => {
      const btn = e.target.closest(".ui-select-option");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      sel.value = btn.dataset.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      wrap.classList.remove("is-open");
      sync();
    });

    wrap.append(trigger, menu);
    sync();

    const mo = new MutationObserver(sync);
    mo.observe(sel, { childList: true, subtree: true, attributes: true });
    sel.addEventListener("change", sync);
  });
}

document.addEventListener("click", (e) => {
  if (e.target.closest(".ui-select")) return;
  document.querySelectorAll(".ui-select.is-open").forEach((el) => el.classList.remove("is-open"));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".ui-select.is-open").forEach((el) => el.classList.remove("is-open"));
  }
});

function switchView(name) {
  ["home", "instances", "pnl", "trades", "alerts", "notify", "bg", "system"].forEach((v) => {
    $(`view-${v}`)?.classList.toggle("hidden", v !== name && !(name === "instance" && v === "instances"));
  });
  if (name === "instance" || name === "instances") {
    $("view-instances").classList.remove("hidden");
  }
  setNav(name);
}

function findInstance(id) {
  if (!state.workspace) return null;
  for (const g of state.workspace.groups || []) {
    const hit = (g.instances || []).find((i) => i.terminal_id === id);
    if (hit) return { ...hit, group_name: g.name, group_id: g.id };
  }
  const u = (state.workspace.ungrouped || []).find((i) => i.terminal_id === id);
  return u ? { ...u, group_name: "未分组", group_id: "" } : null;
}

function renderNav() {
  const ws = state.workspace;
  if (!ws) return;
  const itemHtml = (i) => {
    const label = i.name || i.note || i.terminal_id;
    return `
      <div class="inst-item ${state.selectedId === i.terminal_id ? "active" : ""}" data-id="${escapeHtml(i.terminal_id)}">
        <div class="inst-item-row">
          <div class="name"><span class="dot ${i.online ? "on" : ""}"></span>${escapeHtml(label)}</div>
          <button type="button" class="inst-rename" data-rename-inst="${escapeHtml(i.terminal_id)}" data-current-name="${escapeHtml(label)}" title="改备注名">✎</button>
        </div>
        <div class="sub">${i.online ? "在线" : "离线"} · ${ago(i.last_seen)} · ${escapeHtml(i.account || "未对接")}</div>
      </div>`;
  };
  // 分组默认收起；只有用户点开或选中实例后才展开（collapsedGroups[id] === false）
  const isCollapsed = (gid) => state.collapsedGroups[gid] !== false;
  const blocks = (ws.groups || []).map((g) => {
    const count = (g.instances || []).length;
    const collapsed = isCollapsed(g.id);
    const items = (g.instances || []).map(itemHtml).join("")
      || `<div class="inst-item sub" style="cursor:default;color:var(--muted)">暂无实例</div>`;
    return `<div class="g-block ${collapsed ? "collapsed" : ""}" data-group-block="${escapeHtml(g.id)}">
      <div class="g-head" data-toggle-group="${escapeHtml(g.id)}">
        <div class="g-head-title">
          <span class="g-toggle">${collapsed ? "▶" : "▼"}</span>
          <span class="g-name">${escapeHtml(g.name)}</span>
          <span class="g-count">${count}</span>
        </div>
        <span class="g-head-actions">
          <button type="button" data-rename-group="${g.id}" title="改名">✎</button>
          ${g.id === "default" ? "" : `<button type="button" data-del-group="${g.id}" title="删除">×</button>`}
        </span>
      </div>
      <div class="g-body">${items}</div>
    </div>`;
  }).join("");
  const un = (ws.ungrouped || []).map(itemHtml).join("");
  const unCollapsed = isCollapsed("__ungrouped");
  $("group-nav").innerHTML = blocks + (un ? `<div class="g-block ${unCollapsed ? "collapsed" : ""}" data-group-block="__ungrouped">
    <div class="g-head" data-toggle-group="__ungrouped">
      <div class="g-head-title">
        <span class="g-toggle">${unCollapsed ? "▶" : "▼"}</span>
        <span class="g-name">未分组</span>
        <span class="g-count">${(ws.ungrouped || []).length}</span>
      </div>
    </div>
    <div class="g-body">${un}</div>
  </div>` : "");
}

function renderPosPage() {
  const rows = state.posRows || [];
  const positions = rows.filter((r) => String(r.kind || "").toLowerCase() !== "pending");
  const pending = rows.filter((r) => String(r.kind || "").toLowerCase() === "pending");
  if (!window.BooksUI) return;
  const hc = (state.homeCards || []).find((c) => c.terminal_id === state.selectedId);
  const qd = Number(hc?.quote_digits ?? state.instQuoteDigits ?? 2);
  BooksUI.renderBooksPanel({
    root: $("inst-books"),
    totalEl: $("inst-books-count"),
    posCountEl: $("inst-pos-count"),
    pendingCountEl: $("inst-pending-count"),
    posTableEl: $("inst-pos"),
    pendingTableEl: $("inst-pending"),
    positions,
    pending,
    showPending: true,
    quoteDigits: qd,
  });
}

function monthKey(d = new Date()) {
  // 与成交按北京日切日一致，避免本地时区把「本月」算偏
  return beijingDayKey(d).slice(0, 7);
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(ym) {
  const [y, m] = ym.split("-");
  return `${y} 年 ${Number(m)} 月`;
}

function collectMonths(daily) {
  const set = new Set((daily || []).map((d) => String(d.day || "").slice(0, 7)).filter(Boolean));
  set.add(monthKey());
  return [...set].sort().reverse();
}

/** 优先选「有成交」的月份，避免停在空月看起来全是 —（分享页默认也是有数的月） */
function preferredMonth(daily, current = "") {
  const withData = [
    ...new Set(
      (daily || [])
        .filter((d) => Number(d.trades || 0) > 0 || Number(d.pnl || 0) !== 0)
        .map((d) => String(d.day || "").slice(0, 7))
        .filter(Boolean),
    ),
  ].sort().reverse();
  if (current && withData.includes(current)) return current;
  if (withData.length) return withData[0];
  if (current) return current;
  return monthKey();
}

function fillMonthSelect(selectEl, months, selected) {
  if (!selectEl) return;
  const list = months.length ? months : [monthKey()];
  const cur = list.includes(selected) ? selected : list[0];
  selectEl.innerHTML = list.map((m) =>
    `<option value="${m}" ${m === cur ? "selected" : ""}>${formatMonthLabel(m)}</option>`
  ).join("");
  return cur;
}

function renderPnlCalendar(el, sumEl, daily, ym, selectedDay = "") {
  if (!el) return;
  const map = new Map((daily || []).map((d) => [d.day, d]));
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const startPad = (first.getDay() + 6) % 7;
  const today = new Date();
  const todayKeyStr = beijingDayKey(today);
  const todayDay = todayKeyStr.startsWith(ym) ? Number(todayKeyStr.slice(8, 10)) : -1;

  let monthPnl = 0;
  let monthTrades = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${ym}-${String(day).padStart(2, "0")}`;
    const row = map.get(key);
    if (row) {
      monthPnl += Number(row.pnl || 0);
      monthTrades += Number(row.trades || 0);
    }
  }
  if (sumEl) {
    sumEl.innerHTML = `本月 <b class="${pnlClass(monthPnl)}">${fmtN(monthPnl)}</b> · ${monthTrades} 笔`;
  }

  const heads = ["一", "二", "三", "四", "五", "六", "日"]
    .map((h) => `<div class="pnl-cal-head">${h}</div>`).join("");
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(`<div class="pnl-cal-cell empty"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${ym}-${String(day).padStart(2, "0")}`;
    const row = map.get(key);
    const has = !!row && (Number(row.trades || 0) > 0 || Number(row.pnl || 0) !== 0
      || Number(row.max_profit || 0) > 0 || Number(row.max_drawdown || 0) > 0);
    const pnl = row ? Number(row.pnl || 0) : null;
    const trades = row ? Number(row.trades || 0) : 0;
    const maxDd = row ? Number(row.max_drawdown || 0) : 0;
    const cls = [
      "is-day",
      day === todayDay ? "today" : "",
      selectedDay === key ? "is-selected" : "",
      has ? "has-data" : "",
    ].filter(Boolean).join(" ");
    const pnlHtml = !has
      ? ""
      : `<span class="pnl-cal-pnl ${pnlClass(pnl)}">${pnl >= 0 ? "+" : ""}${fmtN(pnl)}</span>`;
    const detailHtml = has ? `
      <div class="pnl-cal-extra">
        <span class="neg">最大浮亏 -${fmtN(maxDd)}</span>
      </div>
      ${trades ? `<span class="pnl-cal-trades">${trades} 笔</span>` : ""}` : "";
    cells.push(`
      <button type="button" class="pnl-cal-cell ${cls}" data-day="${key}" title="查看 ${key} 成交">
        <span class="pnl-cal-day">${day}</span>
        ${pnlHtml}
        ${detailHtml}
      </button>`);
  }
  el.innerHTML = heads + cells.join("");
}

function beijingDayKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function dayRangeSec(dayKey) {
  const from = Math.floor(Date.parse(`${dayKey}T00:00:00+08:00`) / 1000);
  const to = from + 86400 - 1;
  return { from, to };
}

async function loadDayTrades(scope, dayKey, opts = {}) {
  // 默认不滚；只有用户亲手点日历格子时再 scroll:true
  // soft：定时刷新时不闪「加载中」、并保留明细表滚动位置
  const { scroll = false, soft = false } = opts;
  const isInst = scope === "inst";
  const panel = $(isInst ? "inst-day-panel" : "pnl-day-panel");
  const title = $(isInst ? "inst-day-title" : "pnl-day-title");
  const meta = $(isInst ? "inst-day-meta" : "pnl-day-meta");
  const tableEl = $(isInst ? "inst-day-table" : "pnl-day-table");
  if (!panel || !tableEl) return;

  if (isInst) state.instDayKey = dayKey;
  else state.pnlDayKey = dayKey;

  const terminalId = isInst ? state.selectedId : ($("pnl-scope")?.value || "");
  const { from, to } = dayRangeSec(dayKey);
  const qs = new URLSearchParams({
    from: String(from),
    to: String(to),
    limit: "300",
  });
  if (terminalId) qs.set("terminal_id", terminalId);

  const keepTableScroll = tableEl.scrollTop || 0;
  panel.classList.remove("hidden");
  title.textContent = `${dayKey} 成交明细`;
  if (!soft) {
    meta.textContent = "加载中…";
    tableEl.innerHTML = `<p class="muted">加载中…</p>`;
  }
  if (scroll) {
    try {
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch {
      /* ignore */
    }
  }

  try {
    const data = await api(`/api/v1/trades?${qs}`);
    const allRows = data.rows || [];
    // 只显示平仓/反手（开仓盈利恒为 0，跟日历「今日平仓」一致）
    const rows = allRows.filter((r) => {
      const e = String(r.entry || "").toLowerCase();
      return e === "out" || e === "inout" || e === "";
    });
    const total = rows.length;
    const sum = rows.reduce((a, r) => a + Number(r.profit || 0) + Number(r.commission || 0) + Number(r.swap || 0), 0);
    if (meta) meta.textContent = "";

    const brokerOff = Number(data.broker_gmt_offset || 0);
    const qd = Number(data.quote_digits || 2);
    const sig = `closes|${total}|${brokerOff}|${qd}|${rows.map((r) => `${r.ticket || ""}:${r.ts || 0}:${r.entry || ""}:${r.profit || 0}:${r.commission || 0}:${r.swap || 0}`).join(",")}`;
    const same = soft && tableEl.dataset.daySig === sig;
    if (!rows.length) {
      tableEl.dataset.daySig = sig;
      tableEl.innerHTML = `<p class="muted">暂无平仓</p>`;
    } else if (!same) {
      tableEl.dataset.daySig = sig;
      if (window.BooksUI?.renderMt5DealsTable) {
        BooksUI.renderMt5DealsTable(tableEl, rows, {
          fmtTime: (v) => fmtBeijing(v),
          fmtServerTime: (v) => fmtBrokerServer(v, brokerOff),
          priceDigits: qd > 0 ? qd : 2,
          moneyDigits: moneyDigitsFromQuote(qd, sum),
        });
      } else {
        table(tableEl, [
          { key: "ts", label: "北京时间" },
          { key: "symbol", label: "品种" },
          { key: "side", label: "类型" },
          { key: "volume", label: "手数" },
          { key: "price_open", label: "开仓价位" },
          { key: "price", label: "开平价位" },
          { key: "profit", label: "盈利" },
          { key: "comment", label: "备注" },
        ], rows, {
          ts: (v) => fmtBeijing(v),
          side: (v, r) => (window.BooksUI?.positionSideLabel || window.BooksUI?.sideLabel || ((s) => s))(v, r?.entry),
          volume: (v) => fmtN(v, 2),
          price_open: (v) => (Number(v) > 0 ? fmtN(v, qd > 0 ? qd : 2) : "—"),
          price: (v) => (Number(v) > 0 ? fmtN(v, qd > 0 ? qd : 2) : "—"),
          profit: (v, r) => {
            const n = Number(v || 0) + Number(r.commission || 0) + Number(r.swap || 0);
            return `<span class="${pnlClass(n)}">${n >= 0 ? "+" : ""}${fmtN(n)}</span>`;
          },
          comment: (v) => escapeHtml(v || "-"),
        });
      }
    }

    // 重绘后恢复明细表内部滚动，避免突然跳回顶部
    requestAnimationFrame(() => {
      tableEl.scrollTop = keepTableScroll;
    });
  } catch (e) {
    if (!soft) {
      meta.textContent = "";
      tableEl.innerHTML = `<p class="muted">${escapeHtml(e.message || "加载失败")}</p>`;
    }
  }

  // re-render calendar selection highlight
  if (isInst) {
    renderPnlCalendar($("inst-calendar"), $("inst-cal-sum"), state.instDaily, state.instMonth, state.instDayKey);
  } else {
    renderPnlCalendar($("pnl-calendar"), $("pnl-cal-sum"), state.pnlDaily, state.pnlMonth, state.pnlDayKey);
  }
}

function showSecretModal(title, terminalId, apiSecret, onDone) {
  const base = window.location.origin;
  const rows = [
    { key: "InpTerminalId", label: "实例 ID", value: String(terminalId || "") },
    { key: "InpApiSecret", label: "私钥", value: String(apiSecret || "") },
    { key: "InpApiBase", label: "监控后台地址", value: base },
  ];
  const rowsHtml = rows
    .map(
      (r, i) => `
    <div class="secret-row">
      <div class="secret-row-main">
        <span class="secret-lab">${escapeHtml(r.label)} <span class="secret-key">(${escapeHtml(r.key)})</span></span>
        <code class="secret-val">${escapeHtml(r.value)}</code>
      </div>
      <button type="button" class="btn btn-secondary secret-copy-btn" data-secret-copy="${i}">复制</button>
    </div>`,
    )
    .join("");
  openModal(
    title,
    `<p class="muted">请立刻把下面三项分别复制到 EA 对应参数。关闭后无法再看到明文，只能轮换新密钥。</p>
     <div class="secret-rows">${rowsHtml}</div>`,
    `<button class="btn btn-primary" id="m-done">我已复制</button>`,
  );
  $("modal-body").querySelectorAll("[data-secret-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.getAttribute("data-secret-copy"));
      const row = rows[idx];
      if (!row) return;
      const ok = await copyText(row.value);
      btn.textContent = ok ? "已复制" : "失败";
      setTimeout(() => {
        btn.textContent = "复制";
      }, 1500);
    });
  });
  $("m-done").onclick = async () => {
    closeModal();
    if (onDone) await onDone();
  };
}

async function loadWorkspace() {
  state.workspace = await api("/api/v1/workspace");
  renderNav();
  const scope = $("pnl-scope");
  if (scope) {
    const opts = [`<option value="">全部实例</option>`];
    for (const g of state.workspace.groups || []) {
      for (const i of g.instances || []) {
        opts.push(`<option value="${i.terminal_id}">${escapeHtml(i.name || i.note || i.terminal_id)}</option>`);
      }
    }
    for (const i of state.workspace.ungrouped || []) {
      opts.push(`<option value="${i.terminal_id}">${escapeHtml(i.name || i.note || i.terminal_id)}</option>`);
    }
    scope.innerHTML = opts.join("");
  }
  enhanceSelects();
}

async function loadHome() {
  switchView("home");
  await refreshHomeData({ soft: false });
}

/** 总览数据刷新：soft 时不切视图、不改滚动位置，只更新数字 */
async function refreshHomeData(opts = {}) {
  const soft = !!opts.soft;
  const keepY = window.scrollY;
  const [cardsRes, groupsRes] = await Promise.all([
    api("/api/v1/home-cards"),
    api("/api/v1/admin/groups"),
  ]);
  if (soft && $("view-home")?.classList.contains("hidden")) return;

  state.groups = groupsRes.rows || [];
  state.homeCards = cardsRes.cards || [];

  const userGroups = (state.groups || []).filter((g) => g.id && g.id !== "default");
  if (state.homeGroupFilter !== "all" && !userGroups.some((g) => g.id === state.homeGroupFilter)) {
    state.homeGroupFilter = "all";
  }

  const groupQs =
    state.homeGroupFilter && state.homeGroupFilter !== "all"
      ? `?group_id=${encodeURIComponent(state.homeGroupFilter)}`
      : "";
  const ov = await api(`/api/v1/overview${groupQs}`);
  if (soft && $("view-home")?.classList.contains("hidden")) return;

  renderHomeOverview(ov);
  renderHomeGroupFilters();
  renderHomeInstances();

  if (soft) {
    requestAnimationFrame(() => {
      window.scrollTo({ top: keepY, left: 0, behavior: "instant" });
    });
  }
}

function renderHomeOverview(ov) {
  $("stat-cards").innerHTML = [
    ["在线实例", `${ov.online}/${ov.terminals}`],
    ["浮动盈亏", ov.floating, true],
    ["净值合计", ov.equity],
    ["今日收益", ov.today_pnl, true],
    ["本月收益", ov.month_pnl, true],
    ["累计收益", ov.total_pnl, true],
  ].map(([k, v, isPnl]) => `<div class="card glass-card"><div class="k">${k}</div><div class="v ${isPnl ? pnlClass(v) : ""}">${typeof v === "number" ? fmtN(v) : v}</div></div>`).join("");
}

async function refreshHomeOverview() {
  const groupQs =
    state.homeGroupFilter && state.homeGroupFilter !== "all"
      ? `?group_id=${encodeURIComponent(state.homeGroupFilter)}`
      : "";
  const ov = await api(`/api/v1/overview${groupQs}`);
  renderHomeOverview(ov);
}

function renderHomeGroupFilters() {
  const groups = (state.groups || []).filter((g) => g.id && g.id !== "default");
  const chips = [
    `<span class="chip chip-label">实例</span>`,
    `<button type="button" class="chip ${state.homeGroupFilter === "all" ? "is-active" : ""}" data-group-filter="all">全部</button>`,
    ...groups.map((g) =>
      `<button type="button" class="chip ${state.homeGroupFilter === g.id ? "is-active" : ""}" data-group-filter="${escapeHtml(g.id)}">${escapeHtml(g.name)}</button>`
    ),
  ];
  $("home-group-filters").innerHTML = chips.join("");
}

function renderHomeInstances() {
  let list = state.homeCards || [];
  if (state.homeGroupFilter !== "all") {
    list = list.filter((i) => (i.group_id || "default") === state.homeGroupFilter);
  }
  // 在线优先；同状态按名称稳定排序（不用 last_seen，避免心跳互抢导致卡片乱跳）
  list = [...list].sort((a, b) => {
    const ao = a.online ? 1 : 0;
    const bo = b.online ? 1 : 0;
    if (bo !== ao) return bo - ao;
    const ga = String(a.group_name || "");
    const gb = String(b.group_name || "");
    if (ga !== gb) return ga.localeCompare(gb, "zh-CN");
    const na = String(a.name || a.note || a.terminal_id || "");
    const nb = String(b.name || b.note || b.terminal_id || "");
    if (na !== nb) return na.localeCompare(nb, "zh-CN");
    return String(a.terminal_id || "").localeCompare(String(b.terminal_id || ""));
  });

  if (!(state.homeCards || []).length) {
    $("home-instances").innerHTML = `<div class="glass-card inst-box-empty">还没有实例。去「实例管理」创建后，这里会一排三个显示。</div>`;
    return;
  }
  if (!list.length) {
    $("home-instances").innerHTML = `<div class="glass-card inst-box-empty">这个分组下还没有实例。可在「实例管理」里把实例移到该分组。</div>`;
    return;
  }

  $("home-instances").innerHTML = list.map((i) => {
    const titleLeft = `${i.group_name || "默认分组"}`;
    const titleRight = i.name || i.note || i.terminal_id;
    const ccy = i.display_unit || "";
    const qd = i.quote_digits;
    const closeTxt = i.close_count
      ? `${i.close_count} 笔 ${i.last_close_pnl >= 0 ? "+" : ""}${fmtMoneyForInst(i.last_close_pnl, ccy, qd)}`
      : "今日暂无";
    const alertCls = i.alerting ? " is-alerting" : "";
    return `<article class="glass-card inst-box${alertCls}" data-open-instance="${escapeHtml(i.terminal_id)}">
      <div class="inst-box-body">
        <div class="inst-box-head">
          <div class="inst-box-title"><span class="gid">${escapeHtml(titleLeft)}</span>${escapeHtml(titleRight)}</div>
          <span class="${i.online ? "badge-online" : "badge-offline"}">${i.online ? "在线" : "离线"}</span>
        </div>
        <div class="inst-row"><span class="lab">手数</span><span class="val">${fmtN(i.lots, 2)} 手 (${i.position_count} 个持仓)</span></div>
        <div class="inst-float ${pnlClass(i.floating_pl)}">${fmtFloatHeroForInst(i.floating_pl, ccy, qd)}</div>
        <div class="inst-row inst-eq"><span class="lab">净值</span><span class="val ${pnlClass(i.floating_pl)}">${fmtMoneyForInst(i.equity, ccy, qd)}</span></div>
        <div class="inst-row"><span class="lab">余额</span><span class="val">${fmtMoneyForInst(i.balance, ccy, qd)}</span></div>
      </div>
      <div class="inst-stats">
        <div class="inst-row"><span class="lab">今日收益</span><span class="val">${fmtMoneyForInst(i.today_pnl, ccy, qd)}</span></div>
        <div class="inst-row"><span class="lab">昨日收益</span><span class="val">${fmtMoneyForInst(i.yesterday_pnl, ccy, qd)}</span></div>
        <div class="inst-row"><span class="lab">点差</span><span class="val">${i.position_count ? `${fmtN(i.spread || 0, 0)} 点` : "—"}</span></div>
        <div class="inst-row"><span class="lab">杠杆</span><span class="val">${Number(i.leverage) > 0 ? `1:${Number(i.leverage)}` : "—"}</span></div>
        <div class="inst-row"><span class="lab">今日平仓</span><span class="val">${closeTxt}</span></div>
        <div class="inst-row"><span class="lab">今日最大浮亏</span><span class="val neg">${fmtMoneyForInst(i.today_max_float_loss || 0, ccy, qd)}</span></div>
      </div>
      <div class="inst-foot">
        <span class="${i.safe ? "inst-safe" : "inst-unsafe"}"><span class="dot ${i.safe ? "on" : "warn"}"></span>${i.safe ? "安全" : "注意"}</span>
        <span class="inst-dd">历史最大浮亏 <b class="neg">${fmtMoneyForInst(i.max_float_loss, ccy, qd)}</b></span>
      </div>
    </article>`;
  }).join("");
}

async function loadInstancesPage() {
  // 进入实例列表时分组一律收起，需手动点开
  state.collapsedGroups = {};
  switchView("instances");
  await loadWorkspace();
  if (state.selectedId && findInstance(state.selectedId)) {
    await loadInstance(state.selectedId);
  } else {
    $("view-instance").classList.add("hidden");
    $("instance-empty").classList.remove("hidden");
  }
}

function scrollNavToActive() {
  /* 保留：仅在左侧列表内微调，不再调用以免带动整页滚动 */
  const nav = $("group-nav");
  const el = nav?.querySelector(".inst-item.active");
  if (!nav || !el) return;
  const navRect = nav.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  if (elRect.top < navRect.top) {
    nav.scrollTop -= navRect.top - elRect.top + 8;
  } else if (elRect.bottom > navRect.bottom) {
    nav.scrollTop += elRect.bottom - navRect.bottom + 8;
  }
}

async function loadInstance(id, opts = {}) {
  const { soft = false } = opts;
  const keepY = window.scrollY || document.documentElement.scrollTop || 0;
  const switched = state.selectedId !== id;
  state.selectedId = id;
  if (switched && !soft) {
    // 换实例时清空月份记忆，避免停在上个实例翻到的空月
    state.instMonth = "";
    state.instDayKey = "";
  }
  const inst = findInstance(id);

  const nav = $("group-nav");
  const keepNavScroll = nav?.scrollTop || 0;
  renderNav();
  if (nav) nav.scrollTop = keepNavScroll;

  if (!soft) {
    switchView("instance");
    $("instance-empty").classList.add("hidden");
    $("view-instance").classList.remove("hidden");
  } else {
    $("view-instances")?.classList.remove("hidden");
    $("view-instance")?.classList.remove("hidden");
    $("instance-empty")?.classList.add("hidden");
  }
  if (!inst) {
    requestAnimationFrame(() => window.scrollTo({ top: keepY, left: 0, behavior: "instant" }));
    return;
  }

  $("inst-title").textContent = inst.name || inst.note || inst.terminal_id;
  $("inst-meta").innerHTML = `
    <span>ID ${escapeHtml(inst.terminal_id)}</span>
    <span>${inst.online ? "在线" : "离线"} · ${ago(inst.last_seen)}</span>
    <span>${inst.platform || "-"} / ${inst.server || "-"} / 账号 ${inst.account || "-"}</span>
    <span>分组 ${inst.group_name || "-"}</span>`;

  if (!soft) {
    // 正在输入时别覆盖表单
    const ae = document.activeElement;
    const editing = ae && $("view-instance")?.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT");
    if (!editing) {
      $("inst-id").value = inst.terminal_id || "";
      $("inst-name").value = inst.name || inst.note || "";
      $("inst-float-profit").value = Number(inst.float_profit_alert || 0) || "";
      $("inst-float-loss").value = Number(inst.float_loss_alert || 0) || "";
      if ($("inst-display-unit")) $("inst-display-unit").value = inst.display_unit || "";
      if ($("inst-share-intro")) $("inst-share-intro").value = inst.share_intro || "";
      if ($("inst-share-contact")) $("inst-share-contact").value = inst.share_contact || "";
      const groups = state.workspace.groups || [];
      $("inst-group").innerHTML = groups.map((g) =>
        `<option value="${g.id}" ${g.id === inst.group_id ? "selected" : ""}>${escapeHtml(g.name)}</option>`
      ).join("");
      enhanceSelects($("view-instance"));
    }
    $("inst-share-panel")?.classList.add("hidden");
    $("share-msg").textContent = "";
  }

  const fromSec = Math.floor(Date.now() / 1000) - 730 * 86400;
  const toSec = Math.floor(Date.now() / 1000) + 14 * 86400;
  // 持仓 / 盈亏分开拉：持仓失败不能把日历一起弄空（分享页不依赖持仓接口）
  let pos = { rows: [] };
  let pnl = { daily: [], total_pnl: 0 };
  const posP = api(`/api/v1/positions?terminal_id=${encodeURIComponent(id)}`).catch(() => ({ rows: [] }));
  const pnlP = api(`/api/v1/pnl?terminal_id=${encodeURIComponent(id)}&from=${fromSec}&to=${toSec}`).catch(() => ({ daily: [], total_pnl: 0 }));
  const hasCard = (state.homeCards || []).some((c) => c.terminal_id === id);
  const cardsP = (!soft || !hasCard)
    ? api("/api/v1/home-cards")
      .then((d) => {
        state.homeCards = d.cards || [];
        return state.homeCards;
      })
      .catch(() => state.homeCards || [])
    : Promise.resolve(state.homeCards || []);
  pos = await posP;
  pnl = await pnlP;
  await cardsP;
  // 定时刷新时若已切走，别再把页面刷回来
  if (state.selectedId !== id) return;
  if (soft) {
    const stillInst = !$("view-instances")?.classList.contains("hidden");
    if (!stillInst) return;
  }

  const ea = (inst.eas || [])[0] || {};
  const todayKey = beijingDayKey();
  const todayPnl = (pnl.daily || []).filter((d) => d.day === todayKey).reduce((a, b) => a + Number(b.pnl), 0);
  const hc = (state.homeCards || []).find((c) => c.terminal_id === id);
  const posOnly = (pos.rows || []).filter((r) => r.kind === "position");
  const floatingNow = posOnly.length
    ? posOnly.reduce((a, r) => a + Number(r.profit || 0), 0)
    : 0;
  const maxFloatLoss = hc?.max_float_loss != null
    ? Number(hc.max_float_loss) || 0
    : Math.abs(Math.min(0, floatingNow));
  const todayMaxFloatLoss = hc?.today_max_float_loss != null
    ? Number(hc.today_max_float_loss) || 0
    : Math.abs(Math.min(0, floatingNow));
  const ccy = hc?.display_unit || inst.display_unit || "";
  const qd = hc?.quote_digits ?? inst.quote_digits;
  state.instQuoteDigits = Number(qd) || 2;
  $("inst-cards").innerHTML = [
    ["余额", ea.balance ?? "-", false],
    ["净值", ea.equity ?? "-", false],
    ["浮盈", floatingNow, true],
    ["今日已实盈", todayPnl, true],
    ["累计已实盈", pnl.total_pnl || 0, true],
    ["今日最大浮亏", todayMaxFloatLoss, "neg"],
    ["历史最大浮亏", maxFloatLoss, "neg"],
    ["持仓数", posOnly.length, "plain"],
  ].map(([k, v, mode]) => {
    const cls = mode === true ? pnlClass(v) : mode === "neg" ? "neg" : "";
    let text;
    if (typeof v !== "number") text = v;
    else if (mode === "plain") text = fmtN(v, 0);
    else text = fmtMoneyForInst(v, ccy, qd);
    return `<div class="card glass-card"><div class="k">${k}</div><div class="v ${cls}">${text}</div></div>`;
  }).join("");

  const days = pnl.daily || [];
  state.instDaily = days;
  const months = collectMonths(days);
  if (!soft) {
    state.instMonth = preferredMonth(days, state.instMonth);
    state.instMonth = fillMonthSelect($("inst-cal-month"), months, state.instMonth);
    enhanceSelects($("view-instance"));
  } else if (!state.instMonth || !months.includes(state.instMonth)) {
    state.instMonth = preferredMonth(days, state.instMonth);
  }
  renderPnlCalendar($("inst-calendar"), $("inst-cal-sum"), days, state.instMonth, state.instDayKey);
  state.posRows = pos.rows || [];
  renderPosPage();
  if (state.instDayKey) {
    // 绝不因加载实例而滚动页面；soft 时保留明细滚动
    await loadDayTrades("inst", state.instDayKey, { scroll: false, soft });
  } else if (!soft) {
    $("inst-day-panel")?.classList.add("hidden");
  }

  // 内容重绘后恢复滚动位置，避免被拉到底
  requestAnimationFrame(() => {
    window.scrollTo({ top: keepY, left: 0, behavior: "instant" });
  });
}

function shareAbsoluteUrl(path) {
  return `${location.origin}${path}`;
}

function fmtShareTime(ts) {
  return fmtBeijing(ts);
}

async function loadShareList() {
  if (!state.selectedId) return;
  const box = $("share-list");
  if (!box) return;
  box.innerHTML = `<div class="muted">加载中…</div>`;
  try {
    const data = await api(`/api/v1/admin/terminals/${encodeURIComponent(state.selectedId)}/shares`);
    const rows = data.rows || [];
    if (!rows.length) {
      box.innerHTML = `<div class="muted">还没有分享链接，生成一条后可复制发给别人。</div>`;
      return;
    }
    box.innerHTML = rows
      .map((r) => {
        const url = shareAbsoluteUrl(r.path);
        let badge = `<span class="share-badge on">有效</span>`;
        if (!r.active) badge = `<span class="share-badge off">已停止</span>`;
        else if (r.expired) badge = `<span class="share-badge exp">已过期</span>`;
        return `<div class="share-item" data-share="${escapeHtml(r.id)}">
          <div>
            <div class="share-url">${escapeHtml(url)}</div>
            <div class="share-item-meta">${badge}时长 ${r.hours} 小时 · 刷新 ${Number(r.refresh_sec) || 30} 秒 · ${r.show_calendar ? "可点成交" : "仅看日历"} · ${r.show_books ? "挂单开" : "挂单关"} · 创建 ${fmtShareTime(r.created_at)} · 到期 ${fmtShareTime(r.expires_at)}</div>
          </div>
          <div class="share-item-actions">
            ${r.active ? `<button type="button" class="btn btn-secondary" data-share-extend="${escapeHtml(r.id)}">+3小时</button>` : ""}
            <button type="button" class="btn btn-secondary" data-share-copy="${escapeHtml(r.id)}">复制</button>
            ${r.alive ? `<button type="button" class="btn btn-secondary" data-share-stop="${escapeHtml(r.id)}">停止分享</button>` : ""}
            <button type="button" class="btn btn-secondary danger" data-share-del="${escapeHtml(r.id)}">删除</button>
          </div>
        </div>`;
      })
      .join("");
  } catch (err) {
    box.innerHTML = `<div class="muted">${escapeHtml(err.message || "加载失败")}</div>`;
  }
}

$("inst-share")?.addEventListener("click", async () => {
  const panel = $("inst-share-panel");
  if (!panel || !state.selectedId) return;
  const open = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !open);
  if (open) await loadShareList();
});

$("share-create")?.addEventListener("click", async () => {
  if (!state.selectedId) return;
  const hours = Number($("share-hours").value || 24);
  const refreshSec = Number($("share-refresh-sec")?.value || 30);
  const showCalendar = !!$("share-opt-calendar")?.checked;
  const showBooks = !!$("share-opt-books")?.checked;
  $("share-msg").textContent = "生成中…";
  try {
    const res = await api(`/api/v1/admin/terminals/${encodeURIComponent(state.selectedId)}/shares`, {
      method: "POST",
      body: JSON.stringify({
        hours,
        refresh_sec: refreshSec,
        show_calendar: showCalendar,
        show_books: showBooks,
      }),
    });
    const url = shareAbsoluteUrl(res.path);
    $("share-msg").textContent = "已生成新链接";
    try {
      await navigator.clipboard.writeText(url);
      $("share-msg").textContent = "已生成并复制到剪贴板";
    } catch {
      /* ignore */
    }
    await loadShareList();
  } catch (err) {
    $("share-msg").textContent = err.message || "生成失败";
  }
});

$("share-list")?.addEventListener("click", async (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  const extendBtn = t.closest("[data-share-extend]");
  const copyBtn = t.closest("[data-share-copy]");
  const stopBtn = t.closest("[data-share-stop]");
  const delBtn = t.closest("[data-share-del]");
  const extendId = extendBtn?.getAttribute("data-share-extend");
  const copyId = copyBtn?.getAttribute("data-share-copy");
  const stopId = stopBtn?.getAttribute("data-share-stop");
  const delId = delBtn?.getAttribute("data-share-del");
  if (extendId) {
    if (extendBtn instanceof HTMLButtonElement) extendBtn.disabled = true;
    try {
      const res = await api(`/api/v1/admin/shares/${encodeURIComponent(extendId)}/extend`, {
        method: "POST",
        body: "{}",
      });
      $("share-msg").textContent = `已延长 ${res.added_hours || 3} 小时（当前 ${res.hours} 小时）`;
      await loadShareList();
    } catch (err) {
      const msg = err.message || "延长失败";
      $("share-msg").textContent = msg;
      alert(msg);
      if (extendBtn instanceof HTMLButtonElement) extendBtn.disabled = false;
    }
    return;
  }
  if (copyId) {
    const item = copyBtn?.closest(".share-item");
    const url = item?.querySelector(".share-url")?.textContent || "";
    try {
      await navigator.clipboard.writeText(url);
      $("share-msg").textContent = "已复制链接";
    } catch {
      prompt("复制链接", url);
    }
    return;
  }
  if (stopId) {
    if (!(await confirmModal("停止后此链接立即失效，确定？", { title: "停止分享", danger: true }))) return;
    await api(`/api/v1/admin/shares/${encodeURIComponent(stopId)}/stop`, { method: "POST", body: "{}" });
    $("share-msg").textContent = "已停止分享";
    await loadShareList();
    return;
  }
  if (delId) {
    if (!(await confirmModal("删除此分享链接？", { title: "删除链接", danger: true }))) return;
    await api(`/api/v1/admin/shares/${encodeURIComponent(delId)}`, { method: "DELETE" });
    $("share-msg").textContent = "已删除";
    await loadShareList();
  }
});

async function loadPnlPage() {
  switchView("pnl");
  const tid = $("pnl-scope").value;
  const fromSec = Math.floor(Date.now() / 1000) - 730 * 86400;
  const toSec = Math.floor(Date.now() / 1000) + 14 * 86400;
  const qs = new URLSearchParams({ from: String(fromSec), to: String(toSec) });
  if (tid) qs.set("terminal_id", tid);
  const pnl = await api(`/api/v1/pnl?${qs.toString()}`);
  const days = pnl.daily || [];
  state.pnlDaily = days;
  const months = collectMonths(days);
  state.pnlMonth = preferredMonth(days, state.pnlMonth);
  state.pnlMonth = fillMonthSelect($("pnl-cal-month"), months, state.pnlMonth);
  enhanceSelects($("view-pnl"));

  const monthRows = days.filter((d) => String(d.day).startsWith(state.pnlMonth));
  const monthPnl = monthRows.reduce((a, b) => a + Number(b.pnl || 0), 0);
  $("pnl-cards").innerHTML = [
    ["累计收益", pnl.total_pnl, true],
    ["本月收益", monthPnl, true],
    ["有成交天数", days.length],
  ].map(([k, v, isPnl]) => `<div class="card glass-card"><div class="k">${k}</div><div class="v ${isPnl ? pnlClass(v) : ""}">${typeof v === "number" ? fmtN(v) : v}</div></div>`).join("");

  renderPnlCalendar($("pnl-calendar"), $("pnl-cal-sum"), days, state.pnlMonth, state.pnlDayKey);
  table($("pnl-monthly"), [
    { key: "month", label: "月份" }, { key: "pnl", label: "当月" }, { key: "trades", label: "笔数" },
  ], [...(pnl.monthly || [])].reverse(), {
    month: (v) => formatMonthLabel(v),
    pnl: (v) => `<span class="${pnlClass(v)}">${fmtN(v)}</span>`,
  });
  if (state.pnlDayKey) {
    loadDayTrades("pnl", state.pnlDayKey, { soft: true }).catch(() => {});
  } else {
    $("pnl-day-panel")?.classList.add("hidden");
  }
}

async function fillTradeFilters() {
  try {
    state.workspace = await api("/api/v1/workspace");
  } catch (e) {
    renderTradesEmpty("加载分组失败：" + (e.message || "请刷新重试"));
    return;
  }

  const groupSel = $("t-group");
  const termSel = $("t-terminal");
  if (!groupSel || !termSel) return;

  const ws = state.workspace || { groups: [], ungrouped: [] };
  const groups = [];
  for (const g of ws.groups || []) {
    groups.push({
      id: String(g.id),
      name: String(g.name || g.id),
      count: (g.instances || []).length,
    });
  }
  if ((ws.ungrouped || []).length) {
    groups.push({ id: "__ungrouped", name: "未分组", count: ws.ungrouped.length });
  }

  const keepGroup = state.tradeGroupId && groups.some((g) => g.id === state.tradeGroupId)
    ? state.tradeGroupId
    : "";

  groupSel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = groups.length ? "请选择分组" : "暂无分组";
  groupSel.appendChild(ph);
  for (const g of groups) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = `${g.name}（${g.count}个实例）`;
    if (g.id === keepGroup) opt.selected = true;
    groupSel.appendChild(opt);
  }
  state.tradeGroupId = keepGroup;
  fillTradeTerminalSelect();
}

function instancesInTradeGroup(groupId) {
  const ws = state.workspace || { groups: [], ungrouped: [] };
  if (!groupId) return [];
  if (groupId === "__ungrouped") return ws.ungrouped || [];
  const g = (ws.groups || []).find((x) => String(x.id) === String(groupId));
  return g?.instances || [];
}

function fillTradeTerminalSelect() {
  const groupSel = $("t-group");
  const termSel = $("t-terminal");
  if (!groupSel || !termSel) return;

  const groupId = groupSel.value || "";
  state.tradeGroupId = groupId;

  termSel.innerHTML = "";
  const ph = document.createElement("option");

  if (!groupId) {
    termSel.disabled = true;
    ph.value = "";
    ph.textContent = "请先选择分组";
    termSel.appendChild(ph);
    state.tradeTerminalId = "";
    return;
  }

  const list = instancesInTradeGroup(groupId);
  termSel.disabled = false;
  if (!list.length) {
    ph.value = "";
    ph.textContent = "该分组下没有实例";
    termSel.appendChild(ph);
    state.tradeTerminalId = "";
    return;
  }

  ph.value = "";
  ph.textContent = "请选择实例（备注名）";
  termSel.appendChild(ph);

  const keep = state.tradeTerminalId && list.some((i) => i.terminal_id === state.tradeTerminalId)
    ? state.tradeTerminalId
    : "";
  state.tradeTerminalId = keep;

  for (const i of list) {
    const opt = document.createElement("option");
    opt.value = i.terminal_id;
    const label = i.name || i.note || i.terminal_id;
    opt.textContent = i.account ? `${label}（账号 ${i.account}）` : String(label);
    if (i.terminal_id === keep) opt.selected = true;
    termSel.appendChild(opt);
  }
}

function renderTradesEmpty(msg) {
  const el = $("trades-table");
  if (!el) return;
  el.innerHTML = `<p class="muted" style="padding:12px 0">${escapeHtml(msg)}</p>`;
}

async function loadTradeRows() {
  const terminalId = $("t-terminal")?.value || state.tradeTerminalId || "";
  state.tradeTerminalId = terminalId;

  if (!$("t-group")?.value) {
    renderTradesEmpty("请先在上面「① 选择分组」里选一个分组。");
    return;
  }
  if (!terminalId) {
    renderTradesEmpty("请再在「② 选择实例」里选一个实例（显示备注名）。");
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const qs = new URLSearchParams({
    from: String(nowSec - 30 * 86400),
    to: String(nowSec),
    symbol: $("t-symbol")?.value || "",
    magic: $("t-magic")?.value || "",
    terminal_id: terminalId,
    limit: "100",
  });
  const data = await api(`/api/v1/trades?${qs}`);
  const rows = data.rows || [];
  if (!rows.length) {
    renderTradesEmpty("该实例近 30 天暂无成交记录。");
    return;
  }
  const total = Number(data.total || rows.length);
  const brokerOff = Number(data.broker_gmt_offset || 0);
  table($("trades-table"), [
    { key: "ts", label: "北京时间" },
    { key: "ts_server", label: "服务商时间" },
    { key: "terminal_id", label: "实例" },
    { key: "ea_name", label: "EA" },
    { key: "ticket", label: "票据" },
    { key: "magic", label: "Magic" },
    { key: "symbol", label: "品种" },
    { key: "side", label: "方向" },
    { key: "volume", label: "手数" },
    { key: "profit", label: "盈亏" },
  ], rows.map((r) => ({ ...r, ts_server: r.ts })), {
    ts: (v) => fmtBeijing(v),
    ts_server: (v) => fmtBrokerServer(v, brokerOff),
    volume: (v) => fmtN(v, 2),
    profit: (v) => `<span class="${pnlClass(v)}">${fmtN(v)}</span>`,
  });
  const tip = document.createElement("p");
  tip.className = "muted";
  tip.style.marginTop = "10px";
  tip.textContent = total > rows.length
    ? `当前显示最近 ${rows.length} 条，共 ${total} 条（可导出 CSV 看全部）`
    : `共 ${rows.length} 条成交`;
  $("trades-table").appendChild(tip);
}

async function loadTrades() {
  switchView("trades");
  await fillTradeFilters();
  await loadTradeRows();
}

async function loadAlerts() {
  switchView("alerts");
  const data = await api("/api/v1/alerts");
  const typeName = {
    timeout: "终端超时",
    ea_timeout: "EA 超时",
    ea_error: "EA 错误",
    log_error: "日志错误",
    float_profit: "浮盈达标",
    float_loss: "浮亏达标",
    test: "测试通知",
  };
  const rows = data.rows || [];
  if (!rows.length) {
    $("alerts-table").innerHTML = `<p class="muted">暂无告警记录</p>`;
    return;
  }
  table($("alerts-table"), [
    { key: "ts", label: "时间" },
    { key: "severity", label: "级别" },
    { key: "type", label: "类型" },
    { key: "terminal_id", label: "实例" },
    { key: "message", label: "内容" },
    { key: "acked", label: "状态" },
  ], rows, {
    ts: (v) => fmtTs(v),
    type: (v) => typeName[v] || v || "-",
    message: (v) => `<div class="alert-msg">${escapeHtml(String(v || "")).replace(/\n/g, "<br>")}</div>`,
    acked: (v) => (v ? `<span class="badge-soft">已读</span>` : `<span class="badge-warn">未读</span>`),
  });
}

async function loadNotifySettings() {
  switchView("notify");
  const [s, groupsRes] = await Promise.all([
    api("/api/v1/alert-settings"),
    api("/api/v1/admin/groups"),
  ]);
  const form = $("notify-form");
  form.alert_timeout.checked = !!s.alert_timeout;
  form.alert_ea_timeout.checked = !!s.alert_ea_timeout;
  form.alert_ea_error.checked = !!s.alert_ea_error;
  form.alert_log_error.checked = !!s.alert_log_error;
  form.alert_float_profit.checked = s.alert_float_profit !== false;
  form.alert_float_loss.checked = s.alert_float_loss !== false;
  form.notify_enabled.checked = !!s.notify_enabled;
  form.notify_webhook.value = s.notify_webhook || "";
  form.offline_after_seconds.value = s.offline_after_seconds || 180;
  renderGroupWebhookList(groupsRes.rows || [], s.notify_webhooks || {});
  fillNotifyTestGroupSelect(groupsRes.rows || []);
  $("notify-msg").textContent = "";
}

function renderGroupWebhookList(groups, webhooks) {
  const box = $("group-webhook-list");
  if (!box) return;
  const map = webhooks || {};
  const list = (groups || []).length
    ? groups
    : [{ id: "default", name: "默认分组" }];
  box.innerHTML = list
    .map((g) => {
      const id = escapeHtml(g.id);
      const name = escapeHtml(g.name || g.id);
      const url = escapeHtml(map[g.id] || "");
      return `<div class="group-webhook-row">
        <div class="gname" title="${name}">${name}</div>
        <input type="url" data-group-webhook="${id}" value="${url}" placeholder="该分组专用 Webhook（可留空用默认）" />
      </div>`;
    })
    .join("");
}

function collectGroupWebhooks() {
  const out = {};
  document.querySelectorAll("[data-group-webhook]").forEach((el) => {
    const id = el.getAttribute("data-group-webhook") || "";
    const url = String(el.value || "").trim();
    if (id && url) out[id] = url;
  });
  return out;
}

function fillNotifyTestGroupSelect(groups) {
  const sel = $("notify-test-group");
  if (!sel) return;
  const list = (groups || []).length ? groups : [{ id: "default", name: "默认分组" }];
  const cur = sel.value;
  sel.innerHTML = list
    .map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name || g.id)}</option>`)
    .join("");
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function collectNotifyPayload(form) {
  return {
    alert_timeout: form.alert_timeout.checked,
    alert_ea_timeout: form.alert_ea_timeout.checked,
    alert_ea_error: form.alert_ea_error.checked,
    alert_log_error: form.alert_log_error.checked,
    alert_float_profit: form.alert_float_profit.checked,
    alert_float_loss: form.alert_float_loss.checked,
    notify_enabled: form.notify_enabled.checked,
    notify_webhook: form.notify_webhook.value.trim(),
    notify_webhooks: collectGroupWebhooks(),
    offline_after_seconds: Number(form.offline_after_seconds.value || 180),
  };
}

const DEFAULT_BG = "/assets/site-background.webp";
const BG_MOBILE_MQ = "(max-width: 768px)";

/** @type {{ bg_day_desktop: string, bg_day_mobile: string, bg_night_desktop: string, bg_night_mobile: string } | null} */
let uiBgSettings = null;

function emptyBgSettings() {
  return {
    bg_day_desktop: "",
    bg_day_mobile: "",
    bg_night_desktop: "",
    bg_night_mobile: "",
  };
}

function isMobileViewport() {
  return window.matchMedia(BG_MOBILE_MQ).matches;
}

function isNightTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

function pickBackgroundUrl(settings, opts = {}) {
  const s = settings || emptyBgSettings();
  const night = opts.night != null ? opts.night : isNightTheme();
  const mobile = opts.mobile != null ? opts.mobile : isMobileViewport();
  const primary = night
    ? mobile
      ? s.bg_night_mobile
      : s.bg_night_desktop
    : mobile
      ? s.bg_day_mobile
      : s.bg_day_desktop;
  const fallback = night
    ? mobile
      ? s.bg_night_desktop
      : s.bg_night_mobile
    : mobile
      ? s.bg_day_desktop
      : s.bg_day_mobile;
  const url = (primary && String(primary).trim()) || (fallback && String(fallback).trim()) || "";
  return url || DEFAULT_BG;
}

function cssBgValue(url) {
  const src = displayBgUrl(url);
  return `url("${String(src).replace(/\\/g, "\\\\").replace(/"/g, "%22")}")`;
}

function isVideoBgUrl(url) {
  const path = String(url || "").split("?")[0].toLowerCase();
  return /\.(mp4|webm|mov|ogg)$/.test(path);
}

function applyPageBgMedia(url) {
  const imgEl = document.querySelector(".page-bg-image");
  const videoEl = document.querySelector(".page-bg-video");
  const src = displayBgUrl(url);
  if (isVideoBgUrl(url)) {
    if (imgEl) {
      imgEl.style.backgroundImage = "none";
      imgEl.classList.add("is-video-mode");
    }
    if (videoEl) {
      videoEl.classList.remove("hidden");
      videoEl.muted = true;
      videoEl.defaultMuted = true;
      videoEl.loop = true;
      videoEl.playsInline = true;
      if (videoEl.dataset.src !== src) {
        videoEl.dataset.src = src;
        videoEl.src = src;
        videoEl.load();
      }
      const play = () => videoEl.play().catch(() => {});
      if (videoEl.readyState >= 2) play();
      else videoEl.addEventListener("canplay", play, { once: true });
    }
    return;
  }
  if (videoEl) {
    videoEl.pause();
    if (videoEl.dataset.src) {
      delete videoEl.dataset.src;
      videoEl.removeAttribute("src");
      videoEl.load();
    }
    videoEl.classList.add("hidden");
  }
  if (imgEl) {
    imgEl.classList.remove("is-video-mode");
    imgEl.style.backgroundImage = "";
  }
}

function applyBackgroundUrl(url) {
  applyPageBgMedia(url);
  if (!isVideoBgUrl(url)) {
    const el = document.querySelector(".page-bg-image");
    if (el) el.style.backgroundImage = cssBgValue(url);
  }
}

function applyBackgroundFromSettings(settings) {
  if (settings) uiBgSettings = settings;
  const s = uiBgSettings || emptyBgSettings();
  const day = pickBackgroundUrl(s, { night: false });
  const night = pickBackgroundUrl(s, { night: true });
  const current = pickBackgroundUrl(s);
  const root = document.documentElement;
  if (isVideoBgUrl(current)) {
    root.style.setProperty("--light-bg-image", "none");
    root.style.setProperty("--dark-bg-image", "none");
  } else {
    // 只挂当前主题的图，避免无痕/首次打开时白天+夜间两张大图同时下载
    if (isNightTheme()) {
      root.style.setProperty("--dark-bg-image", cssBgValue(night));
      root.style.setProperty("--light-bg-image", "none");
    } else {
      root.style.setProperty("--light-bg-image", cssBgValue(day));
      root.style.setProperty("--dark-bg-image", "none");
    }
  }
  applyPageBgMedia(current);
}

function displayBgUrl(url) {
  const src = (url && String(url).trim()) || DEFAULT_BG;
  if (!src || src === DEFAULT_BG) return DEFAULT_BG;
  if (src.startsWith("/") && !src.startsWith("//")) {
    // 上传图：若路径无版本参数，补一个，避免旧缓存
    if (src.startsWith("/uploads/bg/") && !src.includes("?")) {
      return `${src}?v=${encodeURIComponent(src)}`;
    }
    return src;
  }
  if (/^https?:\/\//i.test(src)) {
    return `/api/v1/bg-proxy?url=${encodeURIComponent(src)}`;
  }
  return DEFAULT_BG;
}

function readBgFormValues() {
  return {
    bg_day_desktop: ($("bg-day-desktop")?.value || "").trim(),
    bg_day_mobile: ($("bg-day-mobile")?.value || "").trim(),
    bg_night_desktop: ($("bg-night-desktop")?.value || "").trim(),
    bg_night_mobile: ($("bg-night-mobile")?.value || "").trim(),
  };
}

function setBgThumb(slot, url) {
  const id = {
    bg_day_desktop: "thumb-bg_day_desktop",
    bg_day_mobile: "thumb-bg_day_mobile",
    bg_night_desktop: "thumb-bg_night_desktop",
    bg_night_mobile: "thumb-bg_night_mobile",
  }[slot];
  const thumb = id ? $(id) : null;
  if (!thumb) return;
  const oldVid = thumb.querySelector("video");
  if (oldVid) {
    oldVid.pause();
    oldVid.remove();
  }
  if (url && isVideoBgUrl(url)) {
    thumb.style.backgroundImage = "";
    thumb.classList.add("is-on");
    const v = document.createElement("video");
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("muted", "");
    v.src = displayBgUrl(url);
    thumb.appendChild(v);
    v.play().catch(() => {});
    return;
  }
  if (url) {
    thumb.style.backgroundImage = cssBgValue(url);
    thumb.classList.add("is-on");
  } else {
    thumb.style.backgroundImage = "";
    thumb.classList.remove("is-on");
  }
}

function fillBgForm(s) {
  $("bg-day-desktop").value = s.bg_day_desktop || "";
  $("bg-day-mobile").value = s.bg_day_mobile || "";
  $("bg-night-desktop").value = s.bg_night_desktop || "";
  $("bg-night-mobile").value = s.bg_night_mobile || "";
  setBgThumb("bg_day_desktop", s.bg_day_desktop || "");
  setBgThumb("bg_day_mobile", s.bg_day_mobile || "");
  setBgThumb("bg_night_desktop", s.bg_night_desktop || "");
  setBgThumb("bg_night_mobile", s.bg_night_mobile || "");
}

function updateBgPreview(_url) {
  /* 上传界面用各格子缩略图，不再用单独预览块 */
}

async function loadAndApplyBackground() {
  try {
    const res = await fetch("/api/v1/ui-settings", { credentials: "same-origin" });
    if (!res.ok) return;
    const s = await res.json();
    applyBackgroundFromSettings(s);
  } catch {
    /* keep default css */
  }
}

async function loadBgSettings() {
  switchView("bg");
  const s = await api("/api/v1/ui-settings");
  fillBgForm(s);
  uiBgSettings = s;
  $("bg-msg").textContent = "";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

function openCreateInstance() {
  const groups = (state.workspace?.groups || []).map((g) =>
    `<option value="${g.id}">${escapeHtml(g.name)}</option>`
  ).join("");
  openModal(
    "创建实例",
    `<p class="muted">创建后会弹出私钥。把实例 ID 和私钥填进 EA，挂到图表即可对接。</p>
     <label>备注名</label><input id="m-name" placeholder="例如 家里-黄金网格" />
     <label>分组</label><select id="m-group">${groups}</select>
     <label>自定义实例 ID（可留空自动生成）</label><input id="m-id" placeholder="可选" />`,
    `<button class="btn btn-secondary" data-close>取消</button><button class="btn btn-primary" id="m-ok">创建并生成私钥</button>`,
  );
  $("m-ok").onclick = async () => {
    try {
      const body = {
        name: $("m-name").value.trim(),
        group_id: $("m-group").value,
        terminal_id: $("m-id").value.trim() || undefined,
      };
      const res = await api("/api/v1/admin/terminals", { method: "POST", body: JSON.stringify(body) });
      showSecretModal("私钥已生成（只显示一次）", res.terminal_id, res.api_secret, async () => {
        await loadWorkspace();
        await loadInstance(res.terminal_id);
      });
    } catch (e) {
      alert(e.message);
    }
  };
}

async function renameInstance(id, currentName) {
  const name = prompt("备注名", currentName || "");
  if (name == null) return;
  const remark = name.trim();
  if (!remark) {
    alert("备注名不能为空");
    return;
  }
  await api(`/api/v1/admin/terminals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: remark, note: remark }),
  });
  await loadWorkspace();
  if (state.selectedId === id) await loadInstance(id);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ea-theme", theme);
  applyBackgroundFromSettings();
}

function initTheme() {
  const saved = localStorage.getItem("ea-theme");
  if (saved === "light" || saved === "dark") {
    applyTheme(saved);
    return;
  }
  applyTheme("dark");
}

function refreshPnlMonthCard() {
  const el = $("pnl-cards");
  if (!el || el.children.length < 2) return;
  const monthRows = (state.pnlDaily || []).filter((d) => String(d.day).startsWith(state.pnlMonth));
  const monthPnl = monthRows.reduce((a, b) => a + Number(b.pnl || 0), 0);
  const v = el.children[1].querySelector(".v");
  if (!v) return;
  v.className = `v ${pnlClass(monthPnl)}`;
  v.textContent = fmtN(monthPnl);
}

initTheme();

async function boot() {
  try {
    const licRes = await fetch("/api/v1/license", { credentials: "same-origin" });
    const lic = await licRes.json().catch(() => ({}));
    if (lic.enforce && !lic.ok) {
      showLicenseGate(lic);
      return;
    }
    await api("/api/v1/me");
    showApp();
    await loadWorkspace();
    await loadHome();
  } catch (e) {
    if (e.code === 402) {
      showLicenseGate(e.data?.license || { reason: e.message });
      return;
    }
    showGate(e.code === 401 ? "" : e.message);
  }
}

$("license-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = ($("license-key")?.value || "").trim();
  if (!key) {
    $("license-error").textContent = "请粘贴授权码";
    return;
  }
  $("license-error").textContent = "激活中…";
  try {
    const res = await fetch("/api/v1/license/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ key }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "激活失败");
    $("license-error").textContent = "激活成功，请登录";
    showGate("");
  } catch (err) {
    $("license-error").textContent = err.message || "激活失败";
  }
});

$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/v1/login", {
      method: "POST",
      body: JSON.stringify({
        username: ($("login-user")?.value || "").trim() || "admin",
        password: $("login-token").value,
      }),
    });
    showApp();
    await loadWorkspace();
    await loadHome();
  } catch (err) {
    if (err.code === 402) {
      showLicenseGate(err.data?.license || { reason: err.message });
      return;
    }
    $("login-error").textContent = "账号或密码错误，无法进入";
  }
};

$("theme-toggle").onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  const view = ["home", "instances", "pnl"].find((v) => !$(`view-${v}`).classList.contains("hidden"));
  if (view === "home") loadHome().catch(() => {});
  if (view === "instances" && state.selectedId) loadInstance(state.selectedId).catch(() => {});
  if (view === "pnl") loadPnlPage().catch(() => {});
};

/* —— 右上角警报声：触线响、回落停、再触再响；可静音 + 音量 —— */
const SOUND_MUTE_KEY = "ea-alert-sound-muted";
const SOUND_VOL_KEY = "ea-alert-sound-volume";
let soundMuted = localStorage.getItem(SOUND_MUTE_KEY) === "1";
let soundVolume = (() => {
  const n = Number(localStorage.getItem(SOUND_VOL_KEY));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 70;
})();
let soundActive = false;
let soundTimer = null;
let soundCtx = null;

function ensureSoundCtx() {
  if (soundCtx) return soundCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  soundCtx = new AC();
  return soundCtx;
}

function syncVolumeSlider() {
  const el = $("sound-volume");
  if (!el) return;
  el.value = String(soundVolume);
  el.style.setProperty("--vol", `${soundVolume}%`);
  el.title = `警报音量 ${soundVolume}%`;
}

function playAlertBeep(force = false) {
  if (!force && (soundMuted || !soundActive)) return;
  if (soundMuted && !force) return;
  if (soundVolume <= 0) return;
  const ctx = ensureSoundCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  const peak = 0.4 * (soundVolume / 100);

  const tone = (type, freq, t0, dur, amp, filterHz) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    f.type = "lowpass";
    f.frequency.setValueAtTime(filterHz, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0015, amp), t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(f);
    f.connect(g);
    g.connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  };

  // 暖提示：中低频，圆润不刺耳
  tone("sine", 520, now, 0.28, peak, 1400);
  tone("triangle", 650, now + 0.08, 0.32, peak * 0.45, 1200);
  tone("sine", 390, now + 0.36, 0.34, peak * 0.85, 1300);
}

function updateSoundButton() {
  const btn = $("sound-toggle");
  if (!btn) return;
  const icon = btn.querySelector(".sound-icon");
  btn.classList.toggle("is-muted", soundMuted);
  btn.classList.toggle("is-ringing", !soundMuted && soundActive);
  if (icon) icon.textContent = soundMuted ? "🔇" : "🔊";
  btn.title = soundMuted
    ? "警报声：静音（点击开启）"
    : soundActive
      ? "警报声：正在响（点击静音）"
      : "警报声：开（点击静音）";
  syncVolumeSlider();
}

function setSoundRinging(active) {
  soundActive = !!active;
  updateSoundButton();
  if (soundTimer) {
    clearInterval(soundTimer);
    soundTimer = null;
  }
  if (soundActive && !soundMuted) {
    playAlertBeep();
    soundTimer = setInterval(() => playAlertBeep(), 2200);
  }
}

async function pollAlertSound() {
  if ($("app")?.classList.contains("hidden")) {
    setSoundRinging(false);
    return;
  }
  try {
    const data = await api("/api/v1/alerts/sound-status");
    setSoundRinging(!!data.active);
  } catch {
    /* ignore */
  }
}

$("sound-toggle")?.addEventListener("click", () => {
  soundMuted = !soundMuted;
  localStorage.setItem(SOUND_MUTE_KEY, soundMuted ? "1" : "0");
  ensureSoundCtx();
  updateSoundButton();
  if (soundMuted) {
    if (soundTimer) {
      clearInterval(soundTimer);
      soundTimer = null;
    }
  } else if (soundActive) {
    playAlertBeep();
    soundTimer = setInterval(() => playAlertBeep(), 2200);
  } else {
    playAlertBeep(true);
  }
});

let soundVolPreviewAt = 0;
$("sound-volume")?.addEventListener("input", (ev) => {
  soundVolume = Math.min(100, Math.max(0, Number(ev.target.value) || 0));
  localStorage.setItem(SOUND_VOL_KEY, String(soundVolume));
  syncVolumeSlider();
  ensureSoundCtx();
  const now = Date.now();
  if (!soundMuted && now - soundVolPreviewAt > 280) {
    soundVolPreviewAt = now;
    playAlertBeep(true);
  }
});
updateSoundButton();
setInterval(() => {
  pollAlertSound().catch(() => {});
}, 5000);

$("password-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const new_username = ($("pw-user")?.value || "").trim();
  const old_password = ($("pw-old")?.value || "").trim();
  const new_password = ($("pw-new")?.value || "").trim();
  const confirm_password = ($("pw-confirm")?.value || "").trim();
  $("pw-msg").textContent = "保存中…";
  try {
    const res = await api("/api/v1/admin/change-password", {
      method: "POST",
      body: JSON.stringify({ new_username, old_password, new_password, confirm_password }),
    });
    $("password-form")?.reset();
    if (res.username) $("pw-user").value = res.username;
    $("pw-msg").textContent = "管理员帐户已更新";
  } catch (err) {
    $("pw-msg").textContent = err.message || "修改失败";
  }
});

async function loadSystemSettings() {
  try {
    const me = await api("/api/v1/me");
    if (me.username && $("pw-user")) $("pw-user").value = me.username;
    renderLicenseStatus(me.license || null);
  } catch {
    /* ignore */
  }
  loadBackupList().catch(() => {});
}

function fmtBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / (1024 * 1024)).toFixed(2)} MB`;
}

async function loadBackupList() {
  const box = $("backup-list");
  if (!box) return;
  try {
    const data = await api("/api/v1/admin/backups");
    const rows = data.rows || [];
    if (!rows.length) {
      box.innerHTML = `<p class="muted">暂无备份文件。点「下载最新备份」会立刻生成一份。</p>`;
      return;
    }
    box.innerHTML = `
      <p class="muted" style="margin-bottom:8px">服务器保留最近 ${Number(data.keep) || 14} 份 · ${escapeHtml(data.hint || "")}</p>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>文件</th><th>大小</th><th>时间</th><th></th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr>
            <td><code>${escapeHtml(r.file)}</code></td>
            <td>${fmtBytes(r.size)}</td>
            <td>${fmtBeijing(r.mtime)}</td>
            <td class="toolbar" style="gap:6px">
              <button type="button" class="btn btn-sm" data-backup-dl="${escapeHtml(r.file)}">下载</button>
              <button type="button" class="btn btn-sm" data-backup-del="${escapeHtml(r.file)}">删除</button>
            </td>
          </tr>`,
            )
            .join("")}
        </tbody>
      </table></div>`;
  } catch (err) {
    box.innerHTML = `<p class="muted">${escapeHtml(err.message || "无法读取备份列表（需 Node 版服务器）")}</p>`;
  }
}

async function downloadBackupFile(file) {
  const q = file ? `?file=${encodeURIComponent(file)}` : "";
  // Native navigation: browser downloads attachment; avoids fetch+blob hanging on large DB
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = `/api/v1/admin/backup/download${q}`;
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 120000);
}

$("backup-download-btn")?.addEventListener("click", async () => {
  const msg = $("backup-msg");
  const btn = $("backup-download-btn");
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = "正在服务器生成备份，请稍候（约十几秒）…";
  try {
    const row = await api("/api/v1/admin/backup", {
      method: "POST",
      body: JSON.stringify({ label: "download" }),
    });
    if (!row?.file) throw new Error("未返回备份文件名");
    if (msg) msg.textContent = `已生成 ${row.file}，开始下载…`;
    await downloadBackupFile(row.file);
    await loadBackupList();
    if (msg) msg.textContent = `若未自动弹出，请在下方列表点「下载」：${row.file}`;
  } catch (err) {
    const text = err.message || "下载失败";
    if (msg) msg.textContent = text;
    alert(`备份下载失败：${text}`);
  } finally {
    if (btn) btn.disabled = false;
  }
});

$("backup-create-btn")?.addEventListener("click", async () => {
  const msg = $("backup-msg");
  if (msg) msg.textContent = "生成中…";
  try {
    const row = await api("/api/v1/admin/backup", { method: "POST", body: JSON.stringify({ label: "manual" }) });
    if (msg) msg.textContent = `已生成 ${row.file || ""}（${fmtBytes(row.size)}）`;
    await loadBackupList();
  } catch (err) {
    if (msg) msg.textContent = err.message || "生成失败";
    alert(`生成备份失败：${err.message || "未知错误"}`);
  }
});

$("backup-refresh-btn")?.addEventListener("click", () => {
  loadBackupList().catch(() => {});
});

$("backup-list")?.addEventListener("click", async (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  const dl = t.getAttribute("data-backup-dl");
  const del = t.getAttribute("data-backup-del");
  const msg = $("backup-msg");
  if (dl) {
    if (msg) msg.textContent = `下载 ${dl}…`;
    try {
      await downloadBackupFile(dl);
      if (msg) msg.textContent = `已触发下载：${dl}`;
    } catch (err) {
      if (msg) msg.textContent = err.message || "下载失败";
      alert(`下载失败：${err.message || ""}`);
    }
  }
  if (del) {
    if (!confirm(`删除备份 ${del}？`)) return;
    try {
      await api(`/api/v1/admin/backups/${encodeURIComponent(del)}`, { method: "DELETE" });
      if (msg) msg.textContent = "已删除";
      await loadBackupList();
    } catch (err) {
      if (msg) msg.textContent = err.message || "删除失败";
    }
  }
});

function renderLicenseStatus(lic) {
  const line = $("lic-status-line");
  const pills = $("lic-status-pills");
  if (!line || !pills) return;
  if (!lic) {
    line.textContent = "无法读取授权信息";
    pills.innerHTML = "";
    return;
  }
  if (!lic.enforce) {
    line.textContent = "当前服务器未开启授权校验（演示 / 自用模式）";
    pills.innerHTML = `<span class="meta-pill">授权校验 关闭</span>`;
    return;
  }
  const ok = !!lic.ok;
  line.textContent = ok
    ? "授权有效，站点可正常使用"
    : `授权异常：${lic.reason || "未知原因"}`;
  const expTxt =
    lic.exp === 0 || lic.exp == null
      ? "永久"
      : Number(lic.exp) > 0
        ? fmtBeijing(lic.exp)
        : "-";
  pills.innerHTML = [
    `<span class="meta-pill">当前域名 ${escapeHtml(lic.host || "-")}</span>`,
    `<span class="meta-pill">授权域名 ${escapeHtml(lic.domain || "-")}</span>`,
    `<span class="meta-pill">到期 ${escapeHtml(expTxt)}</span>`,
  ].join("");
}
$("logout").onclick = async () => {
  await api("/api/v1/logout", { method: "POST", body: "{}" });
  showGate();
};

$("btn-create-instance").onclick = openCreateInstance;

$("btn-create-group").onclick = () => {
  openModal(
    "新建分组",
    `<label>分组名称</label><input id="m-gname" placeholder="例如 实盘 / 模拟 / 黄金" />`,
    `<button class="btn btn-secondary" data-close>取消</button><button class="btn btn-primary" id="m-gok">创建</button>`,
  );
  $("m-gok").onclick = async () => {
    const name = $("m-gname").value.trim();
    if (!name) return alert("请输入分组名称");
    await api("/api/v1/admin/groups", { method: "POST", body: JSON.stringify({ name }) });
    closeModal();
    const groupsRes = await api("/api/v1/admin/groups");
    state.groups = groupsRes.rows || [];
    await loadWorkspace();
  };
};

$("group-nav").onclick = async (ev) => {
  const renInst = ev.target.closest("[data-rename-inst]");
  const ren = ev.target.closest("[data-rename-group]");
  const del = ev.target.closest("[data-del-group]");
  const toggle = ev.target.closest("[data-toggle-group]");
  const item = ev.target.closest("[data-id]");
  if (renInst) {
    ev.preventDefault();
    ev.stopPropagation();
    await renameInstance(renInst.dataset.renameInst, renInst.dataset.currentName || "");
    return;
  }
  if (ren) {
    ev.preventDefault();
    ev.stopPropagation();
    const name = prompt("新分组名");
    if (!name) return;
    await api(`/api/v1/admin/groups/${encodeURIComponent(ren.dataset.renameGroup)}`, {
      method: "PATCH", body: JSON.stringify({ name }),
    });
    await loadWorkspace();
    return;
  }
  if (del) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!(await confirmModal("删除分组？实例会回到默认分组。", { title: "删除分组", danger: true }))) return;
    await api(`/api/v1/admin/groups/${encodeURIComponent(del.dataset.delGroup)}`, { method: "DELETE" });
    await loadWorkspace();
    return;
  }
  if (toggle && !ev.target.closest("button")) {
    const gid = toggle.dataset.toggleGroup;
    // 默认收起：未记录时视为 collapsed，点一下展开（false）
    const collapsed = state.collapsedGroups[gid] !== false;
    state.collapsedGroups[gid] = !collapsed;
    renderNav();
    return;
  }
  if (item) await loadInstance(item.dataset.id);
};

$("inst-save").onclick = async () => {
  if (!state.selectedId) return;
  const remark = $("inst-name").value.trim();
  const newId = $("inst-id").value.trim();
  if (!remark) {
    alert("备注名不能为空");
    return;
  }
  if (!newId) {
    alert("实例 ID 不能为空");
    return;
  }
  if (newId !== state.selectedId) {
    const ok = await confirmModal(
      `确认把实例 ID 改成「${newId}」？\n改完后请同步修改 EA 里的 InpTerminalId，否则会连不上。`,
      { title: "修改实例 ID" },
    );
    if (!ok) return;
  }
  try {
    const res = await api(`/api/v1/admin/terminals/${encodeURIComponent(state.selectedId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: remark,
        note: remark,
        group_id: $("inst-group").value,
        new_terminal_id: newId,
        float_profit_alert: Number($("inst-float-profit").value) || 0,
        float_loss_alert: Number($("inst-float-loss").value) || 0,
        display_unit: ($("inst-display-unit")?.value || "").trim(),
        share_intro: ($("inst-share-intro")?.value || "").replace(/\r\n/g, "\n"),
        share_contact: ($("inst-share-contact")?.value || "").trim(),
      }),
    });
    const nextId = res.terminal_id || newId;
    state.selectedId = nextId;
    await loadWorkspace();
    await loadInstance(nextId);
  } catch (e) {
    alert(e.message || "保存失败");
  }
};

$("inst-rotate").onclick = async () => {
  if (!state.selectedId) return;
  const ok = await confirmModal("轮换后旧私钥立即失效，EA 需改参数。继续？", {
    title: "轮换私钥",
    okText: "继续轮换",
    danger: true,
  });
  if (!ok) return;
  const res = await api(`/api/v1/admin/terminals/${encodeURIComponent(state.selectedId)}/rotate`, {
    method: "POST", body: "{}",
  });
  showSecretModal("新私钥（只显示一次）", res.terminal_id, res.api_secret);
};

$("inst-del").onclick = async () => {
  if (!state.selectedId) return;
  const tip =
    "确定删除该实例？\n\n会永久删除：成交、持仓、快照、告警、日志、EA 状态等全部数据，不可恢复。";
  if (!(await confirmModal(tip, { title: "删除实例", okText: "确认删除", danger: true }))) return;
  try {
    await api(`/api/v1/admin/terminals/${encodeURIComponent(state.selectedId)}`, { method: "DELETE" });
    state.selectedId = "";
    await loadWorkspace();
    await loadInstancesPage();
    if (typeof loadHome === "function") await loadHome().catch(() => {});
  } catch (err) {
    alert(err.message || "删除失败");
  }
};

document.querySelectorAll("[data-view]").forEach((b) => {
  b.onclick = async () => {
    const v = b.dataset.view;
    if (v === "home") return loadHome();
    if (v === "instances") return loadInstancesPage();
    if (v === "pnl") return loadPnlPage();
    if (v === "trades") return loadTrades();
    if (v === "alerts") return loadAlerts();
    if (v === "notify") return loadNotifySettings();
    if (v === "bg") return loadBgSettings();
    if (v === "system") {
      switchView("system");
      $("pw-msg").textContent = "";
      $("pw-old").value = "";
      $("pw-new").value = "";
      $("pw-confirm").value = "";
      return loadSystemSettings();
    }
  };
});

$("brand-home")?.addEventListener("click", (e) => {
  e.preventDefault();
  loadHome();
});

$("home-instances")?.addEventListener("click", async (ev) => {
  const card = ev.target.closest("[data-open-instance]");
  if (!card) return;
  state.selectedId = card.dataset.openInstance;
  await loadInstancesPage();
});

$("home-group-filters")?.addEventListener("click", (ev) => {
  const chip = ev.target.closest("[data-group-filter]");
  if (!chip) return;
  state.homeGroupFilter = chip.dataset.groupFilter;
  renderHomeGroupFilters();
  renderHomeInstances();
  refreshHomeOverview().catch(() => {});
});

$("pnl-refresh")?.addEventListener("click", loadPnlPage);
$("pnl-scope")?.addEventListener("change", loadPnlPage);
$("pnl-cal-month")?.addEventListener("change", () => {
  state.pnlMonth = $("pnl-cal-month").value;
  renderPnlCalendar($("pnl-calendar"), $("pnl-cal-sum"), state.pnlDaily, state.pnlMonth, state.pnlDayKey);
  refreshPnlMonthCard();
});
$("inst-cal-month")?.addEventListener("change", () => {
  state.instMonth = $("inst-cal-month").value;
  renderPnlCalendar($("inst-calendar"), $("inst-cal-sum"), state.instDaily, state.instMonth, state.instDayKey);
});

document.querySelectorAll(".cal-nav").forEach((btn) => {
  btn.addEventListener("click", () => {
    const which = btn.getAttribute("data-cal");
    const dir = Number(btn.getAttribute("data-dir") || 0);
    if (which === "pnl") {
      state.pnlMonth = shiftMonth(state.pnlMonth || monthKey(), dir);
      const months = collectMonths(state.pnlDaily);
      if (!months.includes(state.pnlMonth)) months.unshift(state.pnlMonth);
      state.pnlMonth = fillMonthSelect($("pnl-cal-month"), [...new Set(months)].sort().reverse(), state.pnlMonth);
      enhanceSelects($("view-pnl"));
      renderPnlCalendar($("pnl-calendar"), $("pnl-cal-sum"), state.pnlDaily, state.pnlMonth, state.pnlDayKey);
      refreshPnlMonthCard();
    } else if (which === "inst") {
      state.instMonth = shiftMonth(state.instMonth || monthKey(), dir);
      const months = collectMonths(state.instDaily);
      if (!months.includes(state.instMonth)) months.unshift(state.instMonth);
      state.instMonth = fillMonthSelect($("inst-cal-month"), [...new Set(months)].sort().reverse(), state.instMonth);
      enhanceSelects($("view-instance"));
      renderPnlCalendar($("inst-calendar"), $("inst-cal-sum"), state.instDaily, state.instMonth, state.instDayKey);
    }
  });
});

$("inst-calendar")?.addEventListener("click", (ev) => {
  const cell = ev.target.closest("[data-day]");
  if (!cell || !state.selectedId) return;
  loadDayTrades("inst", cell.dataset.day, { scroll: true });
});

$("pnl-calendar")?.addEventListener("click", (ev) => {
  const cell = ev.target.closest("[data-day]");
  if (!cell) return;
  loadDayTrades("pnl", cell.dataset.day, { scroll: true });
});

$("t-search")?.addEventListener("click", () => loadTradeRows());

$("t-group")?.addEventListener("change", () => {
  state.tradeGroupId = $("t-group").value || "";
  state.tradeTerminalId = "";
  fillTradeTerminalSelect();
  renderTradesEmpty("分组已选，请再选择「② 选择实例」。");
});

$("t-terminal")?.addEventListener("change", () => {
  state.tradeTerminalId = $("t-terminal").value || "";
  if (state.tradeTerminalId) loadTradeRows();
  else renderTradesEmpty("请选择实例（备注名）。");
});

$("t-export")?.addEventListener("click", () => {
  const terminalId = $("t-terminal")?.value || "";
  if (!terminalId) {
    renderTradesEmpty("请先选择分组和实例，再导出。");
    return;
  }
  const qs = new URLSearchParams({
    from: String(Math.floor(Date.now() / 1000) - 30 * 86400),
    symbol: $("t-symbol")?.value || "",
    magic: $("t-magic")?.value || "",
    terminal_id: terminalId,
  });
  window.location.href = `/api/v1/export/trades.csv?${qs}`;
});

$("ack-all")?.addEventListener("click", async () => {
  await api("/api/v1/alerts/ack", { method: "POST", body: JSON.stringify({ all: true }) });
  loadAlerts();
});

$("clear-read-alerts")?.addEventListener("click", async () => {
  if (!(await confirmModal("确定清理全部已读告警？未读的会保留。", { title: "清理已读告警", danger: true }))) return;
  try {
    const res = await api("/api/v1/alerts/clear-read", { method: "POST", body: "{}" });
    const n = Number(res.deleted || 0);
    alert(n ? `已清理 ${n} 条已读告警` : "没有可清理的已读告警");
    loadAlerts();
  } catch (err) {
    alert(err.message || "清理失败");
  }
});

$("notify-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api("/api/v1/alert-settings", {
      method: "POST",
      body: JSON.stringify(collectNotifyPayload(form)),
    });
    $("notify-msg").textContent = "已保存";
  } catch (err) {
    $("notify-msg").textContent = err.message || "保存失败";
  }
});

$("notify-test")?.addEventListener("click", async () => {
  $("notify-msg").textContent = "发送中…";
  try {
    const form = $("notify-form");
    await api("/api/v1/alert-settings", {
      method: "POST",
      body: JSON.stringify(collectNotifyPayload(form)),
    });
    const groupId = $("notify-test-group")?.value || "";
    await api("/api/v1/alert-settings/test", {
      method: "POST",
      body: JSON.stringify({ group_id: groupId }),
    });
    $("notify-msg").textContent = "测试通知已发送，请去对应 App 查看";
  } catch (err) {
    $("notify-msg").textContent = err.message || "发送失败";
  }
});

$("bg-reset")?.addEventListener("click", async () => {
  fillBgForm(emptyBgSettings());
  $("bg-msg").textContent = "保存中…";
  try {
    const saved = await api("/api/v1/ui-settings", {
      method: "POST",
      body: JSON.stringify(emptyBgSettings()),
    });
    applyBackgroundFromSettings(saved);
    fillBgForm(saved);
    $("bg-msg").textContent = "已恢复默认背景";
  } catch (err) {
    $("bg-msg").textContent = err.message || "失败";
  }
});

// 点「上传图片」→ 主动弹出系统选文件窗口
document.addEventListener("click", (ev) => {
  const pick = ev.target.closest("[data-bg-pick]");
  if (!pick) return;
  ev.preventDefault();
  const slot = pick.getAttribute("data-bg-pick");
  const input = document.querySelector(`[data-bg-upload="${slot}"]`);
  if (!input) {
    if ($("bg-msg")) $("bg-msg").textContent = "找不到上传控件";
    return;
  }
  if ($("bg-msg")) $("bg-msg").textContent = "请选择图片…";
  input.click();
});

document.addEventListener("change", async (ev) => {
  const input = ev.target.closest("[data-bg-upload]");
  if (!input || input.tagName !== "INPUT") return;
  const slot = input.getAttribute("data-bg-upload");
  const file = input.files && input.files[0];
  input.value = "";
  if (!slot || !file) {
    if ($("bg-msg")) $("bg-msg").textContent = "未选择文件";
    return;
  }
  if ($("bg-msg")) $("bg-msg").textContent = `上传中 ${file.name}…`;
  try {
    const fd = new FormData();
    fd.append("slot", slot);
    fd.append("file", file);
    const res = await fetch("/api/v1/bg-upload", {
      method: "POST",
      body: fd,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("登录已失效，请重新登录后再上传");
    if (!res.ok) {
      if (res.status === 413) throw new Error("文件太大（上限约 150MB），请压缩后再传");
      if (res.status === 502 || res.status === 504) throw new Error("服务器处理超时，请换更小的图片再试");
      throw new Error(data.error || `上传失败 (${res.status})`);
    }
    // 立刻用带版本号的 uploaded 路径刷新画面；表单存干净路径
    if (data.uploaded && slot) {
      const clean = String(data.uploaded).split("?")[0];
      data[slot] = clean;
      fillBgForm(data);
      applyBackgroundFromSettings({ ...data, [slot]: data.uploaded });
    } else {
      fillBgForm(data);
      applyBackgroundFromSettings(data);
    }
    const mb = (Number(data.bytes || file.size) / 1024 / 1024).toFixed(2);
    if ($("bg-msg")) $("bg-msg").textContent = `已上传（${mb} MB）并应用`;
  } catch (err) {
    if ($("bg-msg")) $("bg-msg").textContent = err.message || "上传失败";
    alert(err.message || "上传失败");
  }
});

document.querySelectorAll("[data-bg-clear]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const slot = btn.getAttribute("data-bg-clear");
    if (!slot) return;
    const payload = readBgFormValues();
    payload[slot] = "";
    $("bg-msg").textContent = "清除中…";
    try {
      const saved = await api("/api/v1/ui-settings", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      fillBgForm(saved);
      applyBackgroundFromSettings(saved);
      $("bg-msg").textContent = "已清除该背景";
    } catch (err) {
      $("bg-msg").textContent = err.message || "清除失败";
    }
  });
});

window.matchMedia(BG_MOBILE_MQ).addEventListener("change", () => {
  applyBackgroundFromSettings();
});

$("modal").onclick = (ev) => {
  if (ev.target.matches("[data-close], .modal-backdrop")) closeModal();
};

boot();
loadAndApplyBackground();

setInterval(() => {
  if ($("app").classList.contains("hidden")) return;
  const view = ["home", "instances", "pnl"].find((v) => !$(`view-${v}`).classList.contains("hidden"));
  // 总览：10 秒只更新数据，不切页面、不跳滚动
  if (view === "home") refreshHomeData({ soft: true }).catch(() => {});
  // soft：只更新数据，不滚页面、不重置正在编辑的表单
  if (view === "instances" && state.selectedId) {
    loadWorkspace()
      .then(() => loadInstance(state.selectedId, { scroll: false, soft: true }))
      .catch(() => {});
  }
  if (view === "pnl") loadPnlPage().catch(() => {});
}, 10000);
