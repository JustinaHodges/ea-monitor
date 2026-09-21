function $(id) {
  return document.getElementById(id);
}

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

/** 按实例报价位数决定金额显示：2→2位，3→3位；其它默认 2 */
function moneyDigitsFromQuote(quoteDigits, fallbackN) {
  const q = Number(quoteDigits);
  if (q === 3) return 3;
  if (q === 2) return 2;
  if (q === 4) return 4;
  if (fallbackN != null) return moneyDec(fallbackN);
  return 2;
}

function ccySuffix(currency) {
  const u = String(currency || "").trim();
  return u ? ` <span class="ccy">${escapeHtml(u)}</span>` : "";
}

function fmtMoney(n, currency, d) {
  const digits = d == null ? moneyDec(n) : d;
  return `${fmtN(n, digits)}${ccySuffix(currency)}`;
}

function fmtMoneyForInst(n, currency, quoteDigits) {
  return fmtMoney(n, currency, moneyDigitsFromQuote(quoteDigits, n));
}

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
  const v = Number(n || 0);
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return "";
}

function ago(sec) {
  if (!sec) return "从未上报";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

function fmtExpire(sec) {
  return fmtBeijing(sec);
}

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

function renderShareCard(card) {
  const c = card || {};
  const titleLeft = c.group_name || "默认分组";
  const titleRight = c.name || c.note || "实例";
  const ccy = c.display_unit || "";
  const qd = c.quote_digits;
  const closeTxt = c.close_count
    ? `${c.close_count} 笔 ${c.last_close_pnl >= 0 ? "+" : ""}${fmtMoneyForInst(c.last_close_pnl, ccy, qd)}`
    : "今日暂无";
  return `<article class="glass-card inst-box${c.alerting ? " is-alerting" : ""}">
      <div class="inst-box-body">
        <div class="inst-box-head">
          <div class="inst-box-title"><span class="gid">${escapeHtml(titleLeft)}</span>${escapeHtml(titleRight)}</div>
          <div class="inst-box-badges">
            <span class="badge-online">观看 ${Math.max(0, Number(c.viewers) || 0)}</span>
            <span class="${c.online ? "badge-online" : "badge-offline"}">${c.online ? "在线" : "离线"}</span>
          </div>
        </div>
        <div class="inst-row"><span class="lab">手数</span><span class="val">${fmtN(c.lots, 2)} 手 (${Number(c.position_count || 0)} 个持仓)</span></div>
        <div class="inst-float ${pnlClass(c.floating_pl)}">${fmtFloatHeroForInst(c.floating_pl, ccy, qd)}</div>
        <div class="inst-row inst-eq"><span class="lab">净值</span><span class="val ${pnlClass(c.floating_pl)}">${fmtMoneyForInst(c.equity, ccy, qd)}</span></div>
        <div class="inst-row"><span class="lab">余额</span><span class="val">${fmtMoneyForInst(c.balance, ccy, qd)}</span></div>
      </div>
      <div class="inst-stats">
        <div class="inst-row"><span class="lab">今日收益</span><span class="val">${fmtMoneyForInst(c.today_pnl, ccy, qd)}</span></div>
        <div class="inst-row"><span class="lab">昨日收益</span><span class="val">${fmtMoneyForInst(c.yesterday_pnl, ccy, qd)}</span></div>
        <div class="inst-row"><span class="lab">点差</span><span class="val">${c.position_count ? `${fmtN(c.spread || 0, 0)} 点` : "—"}</span></div>
        <div class="inst-row"><span class="lab">杠杆</span><span class="val">${Number(c.leverage) > 0 ? `1:${Number(c.leverage)}` : "—"}</span></div>
        <div class="inst-row"><span class="lab">今日平仓</span><span class="val">${closeTxt}</span></div>
        <div class="inst-row"><span class="lab">今日最大浮亏</span><span class="val neg">${fmtMoneyForInst(c.today_max_float_loss || 0, ccy, qd)}</span></div>
      </div>
      <div class="inst-foot">
        <span class="${c.safe ? "inst-safe" : "inst-unsafe"}"><span class="dot ${c.safe ? "on" : "warn"}"></span>${c.safe ? "安全" : "注意"}</span>
        <span class="inst-dd">历史最大浮亏 <b class="neg">${fmtMoneyForInst(c.max_float_loss, ccy, qd)}</b></span>
      </div>
    </article>`;
}

function tokenFromPath() {
  const m = location.pathname.match(/^\/s\/([^/]+)\/?$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get("t") || "";
}

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function shiftMonth(key, dir) {
  const [y0, m0] = String(key).split("-").map(Number);
  const d = new Date(y0, m0 - 1 + dir, 1);
  return monthKey(d);
}

function collectMonths(days) {
  const set = new Set();
  for (const d of days || []) {
    const day = String(d.day || "");
    if (day.length >= 7) set.add(day.slice(0, 7));
  }
  set.add(monthKey());
  return [...set].sort().reverse();
}

function formatMonthLabel(key) {
  const [y, m] = String(key).split("-");
  return `${y}年${Number(m)}月`;
}

function fillMonthSelect(el, months, selected) {
  const list = months.length ? months : [monthKey()];
  el.innerHTML = list
    .map((m) => `<option value="${m}" ${m === selected ? "selected" : ""}>${formatMonthLabel(m)}</option>`)
    .join("");
  return el.value || selected || list[0];
}

function beijingDayKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 与站内实例月报同一套日历（周一起始、高低回撤）
 *  allowDayTrades=false 时仍显示格子数据，但不给 data-day，无法点开成交
 */
function renderCalendar(root, sumEl, days, month, selectedDay = "", allowDayTrades = true) {
  if (!root) return;
  const map = new Map((days || []).map((d) => [d.day, d]));
  const [y, m] = String(month).split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const startPad = (first.getDay() + 6) % 7;
  const todayKeyStr = beijingDayKey();
  const todayDay = todayKeyStr.startsWith(month) ? Number(todayKeyStr.slice(8, 10)) : -1;

  let monthPnl = 0;
  let monthTrades = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${month}-${String(day).padStart(2, "0")}`;
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
    .map((h) => `<div class="pnl-cal-head">${h}</div>`)
    .join("");
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(`<div class="pnl-cal-cell empty"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${month}-${String(day).padStart(2, "0")}`;
    const row = map.get(key);
    const has =
      !!row &&
      (Number(row.trades || 0) > 0 ||
        Number(row.pnl || 0) !== 0 ||
        Number(row.max_profit || 0) > 0 ||
        Number(row.max_drawdown || 0) > 0);
    const pnl = row ? Number(row.pnl || 0) : null;
    const trades = row ? Number(row.trades || 0) : 0;
    const maxDd = row ? Number(row.max_drawdown || 0) : 0;
    const cls = [
      "is-day",
      day === todayDay ? "today" : "",
      allowDayTrades && selectedDay === key ? "is-selected" : "",
      has ? "has-data" : "",
      allowDayTrades ? "" : "is-static",
    ]
      .filter(Boolean)
      .join(" ");
    const pnlHtml = !has
      ? ""
      : `<span class="pnl-cal-pnl ${pnlClass(pnl)}">${pnl >= 0 ? "+" : ""}${fmtN(pnl)}</span>`;
    const detailHtml = has
      ? `
      <div class="pnl-cal-extra">
        <span class="neg">最大浮亏 -${fmtN(maxDd)}</span>
      </div>
      ${trades ? `<span class="pnl-cal-trades">${trades} 笔</span>` : ""}`
      : "";
    if (allowDayTrades) {
      cells.push(`
      <button type="button" class="pnl-cal-cell ${cls}" data-day="${key}" title="查看 ${key} 成交">
        <span class="pnl-cal-day">${day}</span>
        ${pnlHtml}
        ${detailHtml}
      </button>`);
    } else {
      cells.push(`
      <div class="pnl-cal-cell ${cls}" title="${key}">
        <span class="pnl-cal-day">${day}</span>
        ${pnlHtml}
        ${detailHtml}
      </div>`);
    }
  }
  root.innerHTML = heads + cells.join("");
}

function fmtTs(sec) {
  return fmtBeijing(sec);
}

function dayRangeSec(dayKey) {
  const from = Math.floor(Date.parse(`${dayKey}T00:00:00+08:00`) / 1000);
  const to = from + 86400 - 1;
  return { from, to };
}

async function loadShareDayTrades(dayKey, opts = {}) {
  // soft：定时刷新时不闪「加载中」、不滚页面、保留明细表滚动位置
  const { scroll = true, soft = false } = opts;
  const panel = $("share-day-panel");
  const title = $("share-day-title");
  const meta = $("share-day-meta");
  const tableEl = $("share-day-table");
  if (!panel || !tableEl || !state.token) return;
  if (!state.showDayTrades) {
    panel.classList.add("hidden");
    return;
  }

  state.dayKey = dayKey;
  const { from, to } = dayRangeSec(dayKey);
  const qs = new URLSearchParams({
    from: String(from),
    to: String(to),
    limit: "300",
  });

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

  if (!soft) {
    renderCalendar($("share-calendar"), $("share-cal-sum"), state.daily, state.month, state.dayKey, state.showDayTrades);
  }

  try {
    const res = await fetch(`/api/v1/share/${encodeURIComponent(state.token)}/trades?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "加载失败");

    const allRows = data.rows || [];
    // 只显示平仓/反手
    const rows = allRows.filter((r) => {
      const e = String(r.entry || "").toLowerCase();
      return e === "out" || e === "inout" || e === "";
    });
    const total = rows.length;
    const brokerOff = Number(data.broker_gmt_offset || 0);
    const qd = Number(data.quote_digits || 2);
    const sum = rows.reduce(
      (a, r) => a + Number(r.profit || 0) + Number(r.commission || 0) + Number(r.swap || 0),
      0,
    );
    if (meta) meta.textContent = "";

    const sig = `closes|${total}|${brokerOff}|${qd}|${rows.map((r) => `${r.ticket || ""}:${r.ts || 0}:${r.entry || ""}:${r.profit || 0}:${r.commission || 0}:${r.swap || 0}`).join(",")}`;
    const same = soft && tableEl.dataset.daySig === sig;
    if (!rows.length) {
      tableEl.dataset.daySig = sig;
      if (!same) tableEl.innerHTML = `<p class="muted">暂无平仓</p>`;
    } else if (!same) {
      tableEl.dataset.daySig = sig;
      if (window.BooksUI?.renderMt5DealsTable) {
        BooksUI.renderMt5DealsTable(tableEl, rows, {
          fmtTime: (v) => fmtBeijing(v),
          fmtServerTime: (v) => fmtBrokerServer(v, brokerOff),
          priceDigits: qd > 0 ? qd : 2,
          moneyDigits: moneyDigitsFromQuote(qd, sum),
        });
      }
    }

    requestAnimationFrame(() => {
      tableEl.scrollTop = keepTableScroll;
    });
  } catch (e) {
    if (!soft) {
      meta.textContent = "";
      tableEl.innerHTML = `<p class="muted">${escapeHtml(e.message || "加载失败")}</p>`;
    }
  }
}

function contactLinkInfo(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  // Telegram
  const tg =
    text.match(/^(?:tg|telegram)[:：\s]*@?([A-Za-z0-9_]{4,64})$/i) ||
    text.match(/^@([A-Za-z0-9_]{4,64})$/) ||
    text.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)/i) ||
    text.match(/^tg:\/\/resolve\?domain=([A-Za-z0-9_]+)/i);
  if (tg && tg[1]) {
    const user = tg[1];
    return {
      app: "Telegram",
      label: `TG @${user}`,
      display: `@${user}`,
      deep: `tg://resolve?domain=${encodeURIComponent(user)}`,
      web: `https://t.me/${encodeURIComponent(user)}`,
      hint: "将尝试打开 Telegram 应用；若未安装会跳转网页版。",
    };
  }

  // QQ
  const qqLabeled = text.match(/^(?:qq|QQ)[:：\s]*(\d{5,12})$/);
  const qqDigits = /^\d{5,12}$/.test(text) && !/^1\d{10}$/.test(text) ? text : null;
  const uin = qqLabeled ? qqLabeled[1] : qqDigits;
  if (uin) {
    return {
      app: "QQ",
      label: `QQ ${uin}`,
      display: uin,
      deep: `tencent://message/?uin=${encodeURIComponent(uin)}&Site=&Menu=yes`,
      web: `https://wpa.qq.com/msgrd?v=3&uin=${encodeURIComponent(uin)}&site=qq&menu=yes`,
      hint: "将尝试打开 QQ 应用发起会话；电脑端需已登录 QQ。",
    };
  }

  // Phone
  const phone = text.replace(/[\s\-()]/g, "");
  if (/^1\d{10}$/.test(text) || (/^\+?\d{8,15}$/.test(phone) && !/^\d{5,12}$/.test(text))) {
    const num = /^1\d{10}$/.test(text) ? text : phone;
    return {
      app: "电话",
      label: num,
      display: num,
      deep: `tel:${num}`,
      web: `tel:${num}`,
      hint: "将打开系统拨号界面。",
    };
  }

  // WeChat
  if (/^wx[:：\s]/i.test(text) || /^微信[:：\s]/.test(text) || /^wechat[:：\s]/i.test(text)) {
    const id = text.replace(/^(?:wx|wechat|微信)[:：\s]*/i, "").trim() || text;
    return {
      app: "微信",
      label: `微信 ${id}`,
      display: id,
      deep: "weixin://",
      web: "",
      hint: "将尝试打开微信。因微信限制无法直达会话，打开后请手动搜索该微信号添加。",
    };
  }

  // Direct URL / protocols
  if (/^(https?:\/\/|mailto:|tel:|tencent:|tg:)/i.test(text)) {
    let app = "链接";
    let deep = text;
    let web = text;
    if (/t\.me|telegram|tg:/i.test(text)) {
      app = "Telegram";
      const m = text.match(/(?:t\.me\/|domain=|@)([A-Za-z0-9_]+)/i);
      if (m) deep = `tg://resolve?domain=${encodeURIComponent(m[1])}`;
    } else if (/wpa\.qq|tencent:|uin=/i.test(text)) {
      app = "QQ";
      const m = text.match(/uin=(\d{5,12})/i);
      if (m) deep = `tencent://message/?uin=${m[1]}&Site=&Menu=yes`;
    } else if (/^tel:/i.test(text)) app = "电话";
    else if (/^mailto:/i.test(text)) app = "邮件";
    return {
      app,
      label: text.replace(/^https?:\/\//i, ""),
      display: text,
      deep,
      web,
      hint: `将打开 ${app}。`,
    };
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:].*)?$/i.test(text)) {
    const href = text.startsWith("http") ? text : `https://${text}`;
    return {
      app: "浏览器",
      label: text,
      display: text,
      deep: href,
      web: href,
      hint: "将在浏览器中打开该链接。",
    };
  }

  return {
    app: "联系方式",
    label: text,
    display: text,
    deep: "",
    web: "",
    hint: "无法自动唤起应用，请手动记录该联系方式。",
  };
}

let _contactModalInfo = null;

function closeContactModal() {
  const modal = $("contact-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  _contactModalInfo = null;
}

function launchContactApp(info) {
  if (!info) return;
  const deep = String(info.deep || "").trim();
  const web = String(info.web || "").trim();
  const isTel = /^tel:/i.test(deep) || /^tel:/i.test(web);
  if (isTel) {
    window.location.href = deep || web;
    return;
  }
  const mobile = /Mobile|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if (deep && mobile) {
    const start = Date.now();
    window.location.href = deep;
    if (web && web !== deep) {
      setTimeout(() => {
        if (Date.now() - start < 1600) window.open(web, "_blank", "noopener,noreferrer");
      }, 1100);
    }
    return;
  }
  if (deep) {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "display:none;width:0;height:0;border:0";
    iframe.src = deep;
    document.body.appendChild(iframe);
    setTimeout(() => iframe.remove(), 2000);
  }
  if (web) {
    setTimeout(() => window.open(web, "_blank", "noopener,noreferrer"), deep ? 400 : 0);
  } else if (deep) {
    window.location.href = deep;
  }
}

function openContactModal(info) {
  const modal = $("contact-modal");
  if (!modal || !info) return;
  _contactModalInfo = info;
  const title = $("contact-modal-title");
  const desc = $("contact-modal-desc");
  const value = $("contact-modal-value");
  const hint = $("contact-modal-hint");
  const openBtn = $("contact-modal-open");
  if (title) title.textContent = `通过 ${info.app} 联系`;
  if (desc) desc.textContent = "点击下方按钮将启动对应应用软件。";
  if (value) value.textContent = info.display || info.label;
  if (hint) hint.textContent = info.hint || "";
  if (openBtn) {
    openBtn.textContent = info.deep || info.web ? `打开 ${info.app}` : "知道了";
    openBtn.onclick = () => {
      if (info.deep || info.web) launchContactApp(info);
      closeContactModal();
    };
  }
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function renderShareIntro(text, contact) {
  const panel = $("share-intro-panel");
  const el = $("share-intro");
  const contactEl = $("share-contact");
  if (!panel || !el) return;
  const raw = String(text || "").trim();
  const info = contactLinkInfo(contact);
  if (!raw && !info) {
    panel.classList.add("hidden");
    el.textContent = "";
    if (contactEl) {
      contactEl.classList.add("hidden");
      contactEl.onclick = null;
      const v = $("share-contact-val");
      if (v) v.textContent = "";
    }
    return;
  }
  panel.classList.remove("hidden");
  el.textContent = raw;
  el.classList.toggle("hidden", !raw);
  if (!contactEl) return;
  if (!info) {
    contactEl.classList.add("hidden");
    const emptyVal = $("share-contact-val");
    if (emptyVal) emptyVal.textContent = "";
    contactEl.onclick = null;
    return;
  }
  contactEl.classList.remove("hidden");
  const valEl = $("share-contact-val");
  if (valEl) valEl.textContent = info.label;
  else contactEl.textContent = `作者联系方式 ${info.label}`;
  contactEl.title = "点击打开应用联系";
  contactEl.href = "#";
  contactEl.removeAttribute("target");
  contactEl.onclick = (ev) => {
    ev.preventDefault();
    openContactModal(info);
  };
}

document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  if (t.closest("[data-contact-close]")) closeContactModal();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeContactModal();
});

function renderShareBooks(positions, pending, { showPending = true, quoteDigits = 2 } = {}) {
  if (!window.BooksUI) return;
  BooksUI.renderBooksPanel({
    root: $("share-books"),
    totalEl: $("share-books-count"),
    posCountEl: $("share-pos-count"),
    pendingCountEl: $("share-pending-count"),
    posTableEl: $("share-pos"),
    pendingTableEl: $("share-pending"),
    positions,
    pending,
    showPending,
    pendingClosedText: "分享未开放挂单明细",
    quoteDigits,
  });
}

let state = {
  token: "",
  daily: [],
  month: monthKey(),
  dayKey: "",
  bgReady: false,
  loading: false,
  uiBg: null,
  showDayTrades: true,
  showBooks: true,
  refreshSec: 30,
  refreshTimer: null,
};

function applyShareAutoRefresh(sec) {
  const n = Math.max(5, Math.min(600, Math.floor(Number(sec) || 30)));
  // 间隔没变就别重建定时器，避免刷新节奏被重置
  if (state.refreshTimer && state.refreshSec === n) return;
  state.refreshSec = n;
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
  state.refreshTimer = setInterval(() => {
    if (!state.token || state.loading) return;
    loadShareData({ quiet: true });
  }, n * 1000);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ea-share-theme", theme);
  applyShareBackground();
}

function initTheme() {
  // 分享页独立主题：首次打开默认黑夜，不跟后台亮色互相串
  const saved = localStorage.getItem("ea-share-theme");
  if (saved === "light" || saved === "dark") {
    document.documentElement.setAttribute("data-theme", saved);
    return;
  }
  document.documentElement.setAttribute("data-theme", "dark");
}

function applyShareBackground() {
  const ui = state.uiBg;
  if (!ui) return;
  const mobile = window.matchMedia("(max-width: 768px)").matches;
  const night = document.documentElement.getAttribute("data-theme") === "dark";
  const raw = night
    ? (mobile ? ui.bg_night_mobile : ui.bg_night_desktop) ||
      (mobile ? ui.bg_night_desktop : ui.bg_night_mobile) ||
      ui.bg_day_desktop ||
      ui.bg_url ||
      ""
    : (mobile ? ui.bg_day_mobile : ui.bg_day_desktop) ||
      (mobile ? ui.bg_day_desktop : ui.bg_day_mobile) ||
      ui.bg_night_desktop ||
      ui.bg_url ||
      "";
  const imgEl = document.querySelector(".page-bg-image");
  const videoEl = document.querySelector(".page-bg-video");
  if (!raw) {
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.classList.add("hidden");
    }
    if (imgEl) {
      imgEl.classList.remove("is-video-mode");
      imgEl.style.backgroundImage = "";
    }
    return;
  }
  const src = /^https?:\/\//i.test(raw)
    ? `/api/v1/bg-proxy?url=${encodeURIComponent(raw)}`
    : raw;
  const isVideo = /\.(mp4|webm|mov|ogg)(\?|$)/i.test(String(raw).split("?")[0]);
  if (isVideo && videoEl) {
    if (imgEl) {
      imgEl.style.backgroundImage = "none";
      imgEl.classList.add("is-video-mode");
    }
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
    videoEl.play().catch(() => {});
  } else if (imgEl) {
    if (videoEl) {
      videoEl.pause();
      if (videoEl.dataset.src) {
        delete videoEl.dataset.src;
        videoEl.removeAttribute("src");
        videoEl.load();
      }
      videoEl.classList.add("hidden");
    }
    imgEl.classList.remove("is-video-mode");
    imgEl.style.backgroundImage = `url("${String(src).replace(/"/g, "%22")}")`;
  }
}

async function loadBgOnce() {
  if (state.bgReady) return;
  state.bgReady = true;
  try {
    state.uiBg = await fetch("/api/v1/ui-settings").then((r) => r.json());
    applyShareBackground();
  } catch {
    /* ignore */
  }
}

async function loadShareData({ quiet = false } = {}) {
  const token = state.token || tokenFromPath();
  state.token = token;
  const btn = $("share-refresh");
  const keepY = quiet ? (window.scrollY || document.documentElement.scrollTop || 0) : 0;
  if (!token) {
    $("share-status").textContent = "无效的分享链接";
    $("share-status").classList.remove("hidden");
    btn?.classList.add("hidden");
    return;
  }
  if (state.loading) return;
  state.loading = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "刷新中…";
  }
  if (!quiet) {
    $("share-status").classList.remove("hidden");
    $("share-status").textContent = "加载中…";
  }
  try {
    const res = await fetch(`/api/v1/share/${encodeURIComponent(token)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("share-status").textContent = data.error || "无法打开分享";
      $("share-status").classList.remove("hidden");
      $("share-intro-panel")?.classList.add("hidden");
      $("share-card-wrap")?.classList.add("hidden");
      $("share-books")?.classList.add("hidden");
      $("share-cal-toolbar")?.classList.add("hidden");
      $("share-calendar")?.classList.add("hidden");
      $("share-day-panel")?.classList.add("hidden");
      $("share-expire")?.classList.add("hidden");
      btn?.classList.add("hidden");
      return;
    }
    $("share-status").classList.add("hidden");
    $("share-card-wrap")?.classList.remove("hidden");
    $("share-expire").classList.remove("hidden");
    btn?.classList.remove("hidden");

    state.showDayTrades = data.show_day_trades !== false && data.show_calendar !== false;
    state.showBooks = data.show_pending !== false && data.show_books !== false;
    applyShareAutoRefresh(data.refresh_sec);

    const name = data.card?.name || data.instance?.name || "实例报表";
    document.title = `${name} · 分享报表`;
    $("share-cards").innerHTML = renderShareCard(data.card || data.summary);

    const booksEl = $("share-books");
    booksEl?.classList.remove("hidden");
    renderShareIntro(data.share_intro || data.card?.share_intro || "", data.share_contact || data.card?.share_contact || "");
    renderShareBooks(data.positions || [], data.pending || [], {
      showPending: state.showBooks,
      quoteDigits: Number(data.card?.quote_digits ?? data.quote_digits ?? 2),
    });

    // 日历始终显示；仅控制能否点开当日成交
    $("share-cal-toolbar").classList.remove("hidden");
    $("share-calendar").classList.remove("hidden");
    const keepMonth = state.month;
    state.daily = data.daily || [];
    const months = collectMonths(state.daily);
    if (keepMonth && months.includes(keepMonth)) state.month = keepMonth;
    else state.month = data.month && months.includes(data.month) ? data.month : months[0] || monthKey();
    if (!quiet) {
      state.month = fillMonthSelect($("share-month"), months, state.month);
    } else if ($("share-month") && $("share-month").value !== state.month) {
      state.month = fillMonthSelect($("share-month"), months, state.month);
    }
    if (!state.showDayTrades) {
      state.dayKey = "";
      $("share-day-panel")?.classList.add("hidden");
    }
    renderCalendar(
      $("share-calendar"),
      $("share-cal-sum"),
      state.daily,
      state.month,
      state.dayKey,
      state.showDayTrades,
    );
    if (state.showDayTrades && state.dayKey) {
      // 定时刷新：不滚、不闪加载、保住明细滚动
      await loadShareDayTrades(state.dayKey, { scroll: false, soft: quiet });
    }

    $("share-expire").textContent = `链接有效至 ${fmtExpire(data.expires_at)}（创建后 ${data.hours} 小时）`;
  } catch (e) {
    $("share-status").textContent = e.message || "加载失败";
    $("share-status").classList.remove("hidden");
  } finally {
    state.loading = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "刷新";
    }
    if (quiet) {
      // 内容重绘后多拍两帧再恢复，避免被顶回卡片名字
      const y = keepY;
      requestAnimationFrame(() => {
        window.scrollTo({ top: y, left: 0, behavior: "instant" });
        requestAnimationFrame(() => {
          window.scrollTo({ top: y, left: 0, behavior: "instant" });
        });
      });
    }
  }
}

async function main() {
  await loadBgOnce();
  await loadShareData();
}

$("share-month")?.addEventListener("change", () => {
  state.month = $("share-month").value;
  renderCalendar($("share-calendar"), $("share-cal-sum"), state.daily, state.month, state.dayKey, state.showDayTrades);
});
$("share-prev")?.addEventListener("click", () => {
  state.month = shiftMonth(state.month, -1);
  const months = collectMonths(state.daily);
  if (!months.includes(state.month)) months.unshift(state.month);
  state.month = fillMonthSelect($("share-month"), [...new Set(months)].sort().reverse(), state.month);
  renderCalendar($("share-calendar"), $("share-cal-sum"), state.daily, state.month, state.dayKey, state.showDayTrades);
});
$("share-next")?.addEventListener("click", () => {
  state.month = shiftMonth(state.month, 1);
  const months = collectMonths(state.daily);
  if (!months.includes(state.month)) months.push(state.month);
  state.month = fillMonthSelect($("share-month"), [...new Set(months)].sort().reverse(), state.month);
  renderCalendar($("share-calendar"), $("share-cal-sum"), state.daily, state.month, state.dayKey, state.showDayTrades);
});

$("share-calendar")?.addEventListener("click", (ev) => {
  if (!state.showDayTrades) return;
  const cell = ev.target.closest("[data-day]");
  if (!cell || !state.token) return;
  loadShareDayTrades(cell.dataset.day);
});

$("share-refresh")?.addEventListener("click", () => {
  loadShareData({ quiet: true });
});

$("theme-toggle")?.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
});

window.matchMedia("(max-width: 768px)").addEventListener("change", () => {
  applyShareBackground();
});

initTheme();
main();
