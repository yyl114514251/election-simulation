/* 虚拟选举模拟器 - 前端 SPA（原生 JS，零依赖） */
"use strict";

/* ============ 基础工具 ============ */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function fmtNum(n) {
  n = Number(n || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 10000) return (n / 10000).toFixed(1) + "万";
  return String(n);
}
function fmtPct(r) { return (Number(r || 0) * 100).toFixed(1) + "%"; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ============ API 封装 ============ */
async function api(path, opts) {
  opts = opts || {};
  var res = await fetch(path, opts);
  var ct = res.headers.get("Content-Type") || "";
  if (ct.indexOf("application/json") >= 0) {
    var j = await res.json();
    if (!res.ok) throw new Error(j.error || ("HTTP " + res.status));
    return j.data;
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res;
}
function apiJson(method, path, body) {
  return api(path, {
    method: method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
}

/* ============ Toast ============ */
function toast(msg, type) {
  var wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  var el = document.createElement("div");
  el.className = "toast " + (type || "");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(function () {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(function () { el.remove(); }, 320);
  }, 2600);
}

/* ============ Canvas 图表（零依赖） ============ */
function setupCanvas(cv) {
  var dpr = window.devicePixelRatio || 1;
  var w = cv.clientWidth || 600, h = cv.clientHeight || 260;
  cv.width = w * dpr; cv.height = h * dpr;
  var ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx: ctx, w: w, h: h };
}

function barChart(cv, items, opts) {
  opts = opts || {};
  var s = setupCanvas(cv), ctx = s.ctx, w = s.w, h = s.h;
  ctx.clearRect(0, 0, w, h);
  var padL = 44, padB = 26, padT = 10, padR = 8;
  var cw = w - padL - padR, ch = h - padT - padB;
  var max = 1;
  items.forEach(function (it) { if (it.v > max) max = it.v; });
  max = max * 1.15;
  var n = items.length || 1;
  var bw = cw / n;
  var barW = Math.min(54, bw * 0.6);
  ctx.strokeStyle = "#334155"; ctx.fillStyle = "#64748b";
  ctx.font = "11px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (var g = 0; g <= 4; g++) {
    var gy = padT + ch - (ch * g / 4);
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy);
    ctx.strokeStyle = (g === 0) ? "#475569" : "#1e293b"; ctx.stroke();
    ctx.fillStyle = "#64748b";
    ctx.fillText(fmtNum(max * g / 4), padL - 6, gy);
  }
  items.forEach(function (it, i) {
    var x = padL + i * bw + (bw - barW) / 2;
    var bh = (it.v / max) * ch;
    var y = padT + ch - bh;
    ctx.fillStyle = it.color;
    roundRect(ctx, x, y, barW, Math.max(bh, it.v > 0 ? 2 : 1), 3);
    ctx.fill();
    ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.font = "bold 12px sans-serif";
    if (bh > 26) ctx.fillText(fmtNum(it.v), x + barW / 2, y - 4);
    ctx.fillStyle = "#94a3b8"; ctx.textBaseline = "top"; ctx.font = "11px sans-serif";
    var label = it.label.length > 8 ? it.label.slice(0, 8) + "…" : it.label;
    ctx.fillText(label, x + barW / 2, padT + ch + 6);
  });
  if (opts.title) {
    ctx.fillStyle = "#94a3b8"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.font = "12px sans-serif";
    ctx.fillText(opts.title, padL, 0);
  }
}

function pieChart(cv, items) {
  var s = setupCanvas(cv), ctx = s.ctx, w = s.w, h = s.h;
  ctx.clearRect(0, 0, w, h);
  var total = 0;
  items.forEach(function (it) { total += it.v; });
  var cx = w / 2, cy = h / 2 - 8, R = Math.min(w, h) / 2 - 26, r = R * 0.62;
  if (total <= 0) {
    ctx.fillStyle = "#475569"; ctx.textAlign = "center";
    ctx.font = "13px sans-serif";
    ctx.fillText("暂无票数", cx, cy);
    return;
  }
  var start = -Math.PI / 2;
  items.forEach(function (it) {
    var ang = (it.v / total) * Math.PI * 2;
    if (ang <= 0) return;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, start, start + ang);
    ctx.closePath();
    ctx.fillStyle = it.color;
    ctx.fill();
    start += ang;
  });
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = "#1e293b"; ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "bold 20px sans-serif";
  ctx.fillText(fmtNum(total), cx, cy - 8);
  ctx.fillStyle = "#94a3b8"; ctx.font = "12px sans-serif";
  ctx.fillText("总有效票", cx, cy + 16);
  // 图例
  var ly = h - 22;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  var lx = 10;
  items.slice(0, 6).forEach(function (it) {
    var txt = it.label + " " + fmtPct(it.v / total);
    ctx.font = "11px sans-serif";
    if (lx + ctx.measureText(txt).width + 60 > w && lx > 40) { lx = 10; ly -= 18; }
    ctx.fillStyle = it.color;
    ctx.fillRect(lx, ly - 5, 9, 9);
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(txt, lx + 13, ly);
    lx += ctx.measureText(txt).width + 34;
  });
}

function lineChart(cv, series, opts) {
  opts = opts || {};
  var s = setupCanvas(cv), ctx = s.ctx, w = s.w, h = s.h;
  ctx.clearRect(0, 0, w, h);
  var padL = 44, padB = 24, padT = 14, padR = 10;
  var cw = w - padL - padR, ch = h - padT - padB;
  var max = 1, maxLen = 0;
  series.forEach(function (sr) {
    sr.p.forEach(function (v) { if (v > max) max = v; });
    if (sr.p.length > maxLen) maxLen = sr.p.length;
  });
  max = max * 1.12;
  ctx.strokeStyle = "#334155"; ctx.fillStyle = "#64748b";
  ctx.font = "11px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (var g = 0; g <= 4; g++) {
    var gy = padT + ch - (ch * g / 4);
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy);
    ctx.strokeStyle = (g === 0) ? "#475569" : "#1e293b"; ctx.stroke();
    ctx.fillStyle = "#64748b";
    ctx.fillText(fmtNum(max * g / 4), padL - 6, gy);
  }
  if (maxLen < 1) {
    ctx.fillStyle = "#475569"; ctx.textAlign = "center";
    ctx.font = "13px sans-serif";
    ctx.fillText("投票进行中，等待数据…", padL + cw / 2, padT + ch / 2);
    return;
  }
  series.forEach(function (sr) {
    var n = sr.p.length;
    if (n < 2) {
      // 单点：只画圆点
      var x0 = padL, y0 = padT + ch - (sr.p[0] / max) * ch;
      ctx.fillStyle = sr.color;
      ctx.beginPath(); ctx.arc(x0, y0, 3.5, 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.strokeStyle = sr.color; ctx.lineWidth = 2;
    ctx.beginPath();
    sr.p.forEach(function (v, i) {
      var x = padL + (n === 1 ? 0 : i / (n - 1)) * cw;
      var y = padT + ch - (v / max) * ch;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.lineWidth = 1;
  });
  // 图例
  var ly = h - 20;
  ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = "11px sans-serif";
  var lx = padL;
  series.forEach(function (sr) {
    var txt = sr.label;
    ctx.fillStyle = sr.color; ctx.fillRect(lx, ly - 5, 9, 9);
    ctx.fillStyle = "#94a3b8"; ctx.fillText(txt, lx + 13, ly);
    lx += ctx.measureText(txt).width + 34;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ============ 状态 ============ */
var state = { view: "list", election: null, tab: "overview", votersPage: 1 };

/* ============ 渲染入口 ============ */
function render() {
  var app = document.getElementById("app");
  app.innerHTML = topbarHtml();
  if (state.view === "list") renderList(app);
  else if (state.view === "create") renderCreate(app);
  else if (state.view === "election") renderElection(app);
}

function topbarHtml() {
  return '<div class="topbar">' +
    '<div class="logo">🗳 虚拟<span>选举模拟器</span></div>' +
    '<div class="spacer"></div>' +
    (state.view === "election"
      ? '<button class="btn" onclick="goList()">← 返回列表</button>'
      : '<button class="btn primary" onclick="goCreate()">＋ 新建选举</button>' +
        '<button class="btn green" onclick="createDemo()">✨ 一键演示</button>') +
    '</div><div class="container" id="main"></div>';
}

function goList() { state.view = "list"; render(); loadList(); }
function goCreate() { state.view = "create"; render(); }
function goElection(id) {
  state.view = "election"; state.election = { id: id }; state.tab = "overview";
  state.votersPage = 1;
  render();
  loadElection();
}

/* ============ 列表 ============ */
async function loadList() {
  var main = document.getElementById("main");
  main.innerHTML = '<div class="muted">加载中…</div>';
  try {
    var data = await api("/api/elections");
    renderListContent(main, data.items);
  } catch (e) {
    main.innerHTML = '<div class="empty"><div class="big">⚠️</div>加载失败：' + esc(e.message) +
      '<br><br><button class="btn" onclick="loadList()">重试</button></div>';
  }
}

function renderList(app) {
  app.querySelector("#main").innerHTML = '<div class="muted">加载中…</div>';
  loadList();
}

function renderListContent(main, items) {
  if (!items.length) {
    main.innerHTML = '<div class="empty">' +
      '<div class="big">🗳️</div>' +
      '<div>还没有选举。创建一个新选举，或点击右上角「一键演示」立即体验。</div>' +
      '<div class="mt8"><button class="btn primary" onclick="goCreate()">创建选举</button>' +
      ' <button class="btn green" onclick="createDemo()">一键演示</button></div></div>';
    return;
  }
  var html = '<div class="elec-grid">';
  items.forEach(function (e) {
    var ov = e.overview;
    html += '<div class="card elec-card">' +
      '<div class="head"><div class="title">' + esc(e.title) + '</div>' +
      '<span class="badge ' + e.status + '">' + (STATUS[e.status] || e.status) + '</span></div>' +
      '<div class="desc">' + (esc(e.description) || '<span class="muted">（无描述）</span>') + '</div>' +
      '<div class="stats">' +
      '<span>候选人 ' + e.candidate_count + '</span>' +
      '<span>选区 ' + e.num_districts + '</span>' +
      '<span>选民 ' + fmtNum(ov.total_voters) + '</span>' +
      '<span>投票率 ' + fmtPct(ov.turnout_rate) + '</span>' +
      '</div>' +
      '<div class="actions">' +
      '<button class="btn primary" onclick="goElection(' + e.id + ')">进入</button>' +
      (e.status === "draft"
        ? '<button class="btn sm" onclick="delElection(' + e.id + ')">删除</button>' : "") +
      '</div></div>';
  });
  html += '</div>';
  main.innerHTML = html;
}

async function createDemo() {
  var btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
  try {
    var d = await api("/api/demo", { method: "POST" });
    toast(d.message || "演示选举已创建", "success");
    goElection(d.id);
  } catch (e) {
    toast(e.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "✨ 一键演示"; }
  }
}

async function delElection(id) {
  if (!confirm("确认删除该选举及其全部数据？此操作不可恢复。")) return;
  try {
    await api("/api/elections/" + id, { method: "DELETE" });
    toast("已删除", "success");
    loadList();
  } catch (e) { toast(e.message, "error"); }
}

/* ============ 创建 ============ */
function renderCreate(app) {
  app.querySelector("#main").innerHTML = '<div class="muted">加载中…</div>';
  renderCreateForm(app.querySelector("#main"));
}

function renderElection(app) {
  app.querySelector("#main").innerHTML = '<div class="muted">加载选举详情…</div>';
  loadElection();
}

function renderCreateForm(main) {
  main.innerHTML =
    '<div class="card" style="max-width:640px;margin:0 auto">' +
    '<h3>创建新选举</h3>' +
    '<div class="field"><label>选举名称 *</label>' +
    '<input id="f_title" maxlength="60" placeholder="例如：2026 校园模拟选举"></div>' +
    '<div class="field"><label>描述</label>' +
    '<textarea id="f_desc" rows="2" placeholder="选举背景、规则说明等"></textarea></div>' +
    '<div class="row">' +
    '<div class="field"><label>选区数量</label><select id="f_dist">' +
    [1, 2, 3, 4, 5, 8, 10].map(function (n) {
      return '<option value="' + n + '">' + n + '</option>';
    }).join("") +
    '</select><div class="hint">模拟不同区域选民偏好时使用</div></div>' +
    '<div class="field"><label>计票规则</label><select id="f_rule">' +
    '<option value="plurality">简单多数（得票最多者胜）</option>' +
    '<option value="majority">绝对多数（需超过 50%）</option>' +
    '</select></div>' +
    '</div>' +
    '<div class="row">' +
    '<div class="field"><label>弃权率（默认 5%）</label>' +
    '<input id="f_abstain" type="number" min="0" max="0.9" step="0.01" value="0.05"></div>' +
    '<div class="field"><label>无效票率（默认 1%）</label>' +
    '<input id="f_invalid" type="number" min="0" max="0.5" step="0.01" value="0.01"></div>' +
    '</div>' +
    '<div class="flex mt16">' +
    '<button class="btn" onclick="goList()">取消</button>' +
    '<button class="btn primary grow" onclick="createElection()">创建并添加候选人</button>' +
    '</div></div>';
}

async function createElection() {
  var title = document.getElementById("f_title").value.trim();
  if (!title) { toast("请填写选举名称", "error"); return; }
  try {
    var d = await apiJson("POST", "/api/elections", {
      title: title,
      description: document.getElementById("f_desc").value,
      num_districts: parseInt(document.getElementById("f_dist").value, 10),
      rule: document.getElementById("f_rule").value,
      abstain_rate: parseFloat(document.getElementById("f_abstain").value) || 0,
      invalid_rate: parseFloat(document.getElementById("f_invalid").value) || 0
    });
    toast("选举已创建", "success");
    goElection(d.id);
  } catch (e) { toast(e.message, "error"); }
}

/* ============ 选举详情 ============ */
var STATUS = { draft: "筹备中", voting: "投票中", closed: "已结束" };
var TAB_NAMES = [["overview", "📊 概览"], ["candidates", "👤 候选人"],
  ["voters", "🗂 选民"], ["simulate", "🎯 模拟投票"], ["audit", "📋 审计"]];
var simSeries = [];  // 趋势序列

async function loadElection() {
  var main = document.getElementById("main");
  try {
    var d = await api("/api/elections/" + state.election.id);
    state.election = d;
    renderElectionContent(main);
  } catch (e) {
    main.innerHTML = '<div class="empty"><div class="big">⚠️</div>' + esc(e.message) +
      '<br><br><button class="btn" onclick="goList()">返回列表</button></div>';
  }
}

function renderElectionContent(main) {
  var e = state.election;
  main.innerHTML =
    '<div class="card">' +
    '<div class="flex">' +
    '<div class="grow"><div style="font-size:20px;font-weight:700;color:#fff">' + esc(e.title) + '</div>' +
    '<div class="muted small mt8">' + esc(e.description || "（无描述）") + '</div>' +
    '<div class="flex mt8 small muted">' +
    '<span>规则：' + (e.rule === "majority" ? "绝对多数" : "简单多数") + '</span>' +
    '<span>·</span><span>选区 ' + e.num_districts + ' 个</span>' +
    '<span>·</span><span>弃权率 ' + fmtPct(e.abstain_rate) + '</span>' +
    '<span>·</span><span>无效票率 ' + fmtPct(e.invalid_rate) + '</span>' +
    '</div></div>' +
    '<span class="badge ' + e.status + '" style="font-size:14px">' + STATUS[e.status] + '</span>' +
    '</div>' +
    '<div class="flex mt16">' + statusActions(e) + '</div>' +
    '</div>' +
    '<div class="tabs mt16">' + TAB_NAMES.map(function (t) {
      return '<button class="tab' + (state.tab === t[0] ? " active" : "") +
        '" onclick="setTab(\'' + t[0] + '\')">' + t[1] + '</button>';
    }).join("") + '</div>' +
    '<div id="tab-body"></div>';
  renderTab();
}

function statusActions(e) {
  var html = "";
  if (e.status === "draft") {
    html += '<button class="btn" onclick="addCandForm()">＋ 添加候选人</button>';
    html += '<button class="btn green" onclick="startElection()">▶ 开始投票</button>';
    html += '<button class="btn danger sm" onclick="delElection(' + e.id + ')">删除选举</button>';
  } else if (e.status === "voting") {
    html += '<button class="btn" onclick="resetVotes()">↺ 重置票箱</button>';
    html += '<button class="btn green" onclick="closeElection()">■ 结束投票</button>';
  } else {
    html += '<span class="muted small">选举已结束于 ' + esc(e.closed_at || "") + '</span>';
  }
  if (e.vote_count > 0) {
    html += '<button class="btn sm" onclick="exportCsv(\'result\')">导出结果 CSV</button>';
    html += '<button class="btn sm" onclick="exportCsv(\'votes\')">导出投票明细</button>';
    html += '<button class="btn sm" onclick="exportCsv(\'voters\')">导出选民名单</button>';
  }
  return html;
}

function setTab(t) {
  state.tab = t;
  var body = document.getElementById("tab-body");
  renderTab();
}

function renderTab() {
  var body = document.getElementById("tab-body");
  if (!body) return;
  var e = state.election;
  if (state.tab === "overview") renderOverview(body, e);
  else if (state.tab === "candidates") renderCandidates(body, e);
  else if (state.tab === "voters") renderVoters(body, e);
  else if (state.tab === "simulate") renderSimulate(body, e);
  else if (state.tab === "audit") renderAudit(body, e);
}

/* ---- 概览 ---- */
function renderOverview(body, e) {
  var ov = e.overview;
  var tally = ov.tally;
  body.innerHTML =
    '<div class="stat-grid">' +
    '<div class="stat"><div class="num blue">' + fmtNum(ov.total_voters) + '</div><div class="lab">登记选民</div></div>' +
    '<div class="stat"><div class="num">' + fmtNum(ov.voted) + '</div><div class="lab">已投票</div></div>' +
    '<div class="stat"><div class="num green">' + fmtPct(ov.turnout_rate) + '</div><div class="lab">投票率</div></div>' +
    '<div class="stat"><div class="num amber">' + fmtNum(ov.valid) + '</div><div class="lab">有效票</div></div>' +
    '<div class="stat"><div class="num red">' + fmtNum(ov.invalid) + '</div><div class="lab">无效票</div></div>' +
    '</div>' +
    '<div class="charts-2 mt16">' +
    '<div class="chart-wrap"><canvas id="c_bar" class="chart" height="240"></canvas></div>' +
    '<div class="chart-wrap"><canvas id="c_pie" class="chart" height="240"></canvas></div>' +
    '</div>' +
    '<div class="card mt16"><h3>分选区结果</h3><div id="dist-tbl"></div></div>';
  var items = tally.map(function (t) {
    return { label: t.name, v: t.votes, color: t.color };
  });
  barChart(document.getElementById("c_bar"), items, { title: "候选人得票" });
  pieChart(document.getElementById("c_pie"), items);
  renderDistrictTable(document.getElementById("dist-tbl"), e.districts, tally);
}

function renderDistrictTable(el, districts, tally) {
  if (!districts.length) {
    el.innerHTML = '<div class="muted small">暂无数据</div>';
    return;
  }
  var winners = tally.length ? tally[0].id : null;
  var html = '<table class="tbl"><tr><th>选区</th>';
  tally.forEach(function (t) {
    html += '<th>' + esc(t.name) + '</th>';
  });
  html += '<th>优胜者</th></tr>';
  districts.forEach(function (d) {
    html += '<tr><td>第 ' + d.district + ' 选区</td>';
    var top = null, maxV = -1;
    d.items.forEach(function (it) {
      html += '<td>' + fmtNum(it.votes) + '</td>';
      if (it.votes > maxV) { maxV = it.votes; top = it; }
    });
    html += '<td><b>' + esc(top ? top.name : "—") + '</b></td></tr>';
  });
  html += '</table>';
  el.innerHTML = html;
}

/* ---- 候选人 ---- */
function renderCandidates(body, e) {
  var editable = e.status === "draft";
  var tallyMap = {};
  e.overview.tally.forEach(function (t) { tallyMap[t.id] = t; });
  var html = '<div class="card">';
  html += '<h3>候选人（' + e.candidates.length + '）</h3>';
  if (!e.candidates.length) {
    html += '<div class="muted">还没有候选人。请添加至少 2 名才能开始投票。</div>';
  }
  e.candidates.forEach(function (c, i) {
    html += '<div class="cand-item">' +
      '<span class="dot" style="background:' + esc(c.color) + '"></span>' +
      '<div class="info"><div class="name">' + esc(c.name) + '</div>' +
      '<div class="party">' + esc(c.party || "独立") + (c.bio ? " · " + esc(c.bio) : "") + '</div></div>' +
      '<div class="muted small">得票 ' + fmtNum((tallyMap[c.id] || {}).votes || 0) + '</div>' +
      (editable ? '<button class="btn danger sm" onclick="delCand(' + c.id + ')">删除</button>' : "") +
      '</div>';
  });
  if (editable) {
    html += '<div class="mt16" id="cand-form"></div>';
  }
  html += '</div>';
  body.innerHTML = html;
  if (editable) {
    document.getElementById("cand-form").innerHTML =
      '<div class="field"><label>候选人姓名 *</label>' +
      '<input id="c_name" maxlength="20" placeholder="姓名"></div>' +
      '<div class="row"><div class="field"><label>阵营 / 党派</label>' +
      '<input id="c_party" maxlength="20" placeholder="可选"></div>' +
      '<div class="field"><label>简介</label>' +
      '<input id="c_bio" maxlength="60" placeholder="可选"></div></div>' +
      '<div class="flex"><button class="btn primary" onclick="addCand()">添加候选人</button>' +
      '<span class="muted small">最多 10 名</span></div>';
  }
}

function addCandForm() {
  setTab("candidates");
}

async function addCand() {
  var name = document.getElementById("c_name").value.trim();
  if (!name) { toast("请填写姓名", "error"); return; }
  try {
    await apiJson("POST", "/api/elections/" + state.election.id + "/candidates", {
      name: name,
      party: document.getElementById("c_party").value,
      bio: document.getElementById("c_bio").value
    });
    toast("已添加", "success");
    await loadElection();
  } catch (e) { toast(e.message, "error"); }
}

async function delCand(cid) {
  if (!confirm("确认删除该候选人？")) return;
  try {
    await api("/api/candidates/" + cid, { method: "DELETE" });
    toast("已删除", "success");
    await loadElection();
  } catch (e) { toast(e.message, "error"); }
}

async function startElection() {
  if (!confirm("开始投票？开始后将无法再修改选举信息和候选人。")) return;
  try {
    await api("/api/elections/" + state.election.id + "/start", { method: "POST" });
    toast("投票已开始", "success");
    await loadElection();
  } catch (e) { toast(e.message, "error"); }
}

async function closeElection() {
  if (!confirm("确认结束投票？")) return;
  try {
    await api("/api/elections/" + state.election.id + "/close", { method: "POST" });
    toast("选举已结束", "success");
    await loadElection();
  } catch (e) { toast(e.message, "error"); }
}

async function resetVotes() {
  if (!confirm("确认重置票箱？所有投票记录将被清空，选民恢复未投票状态。")) return;
  try {
    await api("/api/elections/" + state.election.id + "/reset-votes", { method: "POST" });
    toast("票箱已重置", "success");
    simSeries = [];
    await loadElection();
  } catch (e) { toast(e.message, "error"); }
}

/* ---- 选民 ---- */
function renderVoters(body, e) {
  var editable = e.status === "draft";
  var html = '<div class="card">';
  html += '<h3>选民管理（当前 ' + fmtNum(e.voter_count) + ' 人）</h3>';
  if (editable) {
    html += '<div class="row">' +
      '<div class="field"><label>选民数量</label>' +
      '<select id="v_count">' +
      [[1000, "1 千"], [10000, "1 万"], [50000, "5 万"], [100000, "10 万"],
       [500000, "50 万"], [1000000, "100 万"]].map(function (o) {
        return '<option value="' + o[0] + '">' + o[1] + '</option>';
      }).join("") +
      '</select><div class="hint">支持 10 ~ 100 万，批量生成高性能</div></div>' +
      '<div class="field"><label>选区数量</label>' +
      '<select id="v_dist">' + [1, 2, 3, 4, 5, 8, 10].map(function (n) {
        return '<option value="' + n + '"' + (n === e.num_districts ? " selected" : "") + '>' + n + '</option>';
      }).join("") + '</select></div>' +
      '<div class="field"><label>&nbsp;</label>' +
      '<button class="btn primary" onclick="genVoters()" style="width:100%">生成选民</button></div>' +
      '</div>';
    if (e.voter_count > 0) {
      html += '<div class="small muted">已存在选民时需先清空再重新生成。</div>' +
        '<button class="btn danger sm mt8" onclick="clearVoters()">清空选民与投票</button>';
    }
  } else if (e.voter_count === 0) {
    html += '<div class="muted">该选举尚未生成选民。</div>';
  }
  html += '</div>';
  if (e.voter_count > 0) {
    html += '<div class="card mt16"><h3>选民列表</h3>' +
      '<div class="flex"><div class="grow"></div>' +
      '<input id="v_search" placeholder="搜索选民号 / 选区" style="padding:6px 10px;border-radius:8px;' +
      'border:1px solid var(--border);background:#0b1220;color:var(--text)" ' +
      'onkeydown="if(event.key===\'Enter\')loadVotersPage(1)">' +
      '<button class="btn sm" onclick="loadVotersPage(1)">搜索</button></div>' +
      '<div id="voters-tbl" class="mt8"></div></div>';
  }
  body.innerHTML = html;
  if (e.voter_count > 0) loadVotersPage(state.votersPage);
}

async function genVoters() {
  var count = parseInt(document.getElementById("v_count").value, 10);
  var dist = parseInt(document.getElementById("v_dist").value, 10);
  var btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
  try {
    var d = await apiJson("POST", "/api/elections/" + state.election.id + "/voters",
      { count: count, districts: dist });
    toast(d.message, "success");
    await loadElection();
  } catch (e) {
    toast(e.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "生成选民"; }
  }
}

async function clearVoters() {
  if (!confirm("确认清空全部选民与投票记录？")) return;
  try {
    await api("/api/elections/" + state.election.id + "/clear-voters", { method: "POST" });
    toast("已清空", "success");
    await loadElection();
  } catch (e) { toast(e.message, "error"); }
}

async function loadVotersPage(page) {
  var e = state.election;
  var q = document.getElementById("v_search") ? document.getElementById("v_search").value.trim() : "";
  var el = document.getElementById("voters-tbl");
  if (!el) return;
  el.innerHTML = '<div class="muted small">加载中…</div>';
  try {
    var d = await api("/api/elections/" + e.id + "/voters?page=" + page + "&size=50&q=" +
      encodeURIComponent(q));
    var html = '<table class="tbl"><tr><th>选民编号</th><th>选区</th><th>状态</th></tr>';
    d.items.forEach(function (v) {
      html += '<tr><td>' + esc(v.voter_no) + '</td><td>第 ' + v.district + ' 选区</td>' +
        '<td>' + (v.has_voted ? '<span class="score">✓ 已投票' +
          (v.voted_name ? " → " + esc(v.voted_name)
            : '<span class="muted">（无效票）</span>') + '</span>'
          : '<span class="muted">未投票</span>') + '</td></tr>';
    });
    html += '</table>';
    html += '<div class="pager">' +
      '<button class="btn sm" ' + (page <= 1 ? "disabled" : "") + ' onclick="loadVotersPage(' + (page - 1) + ')">上一页</button>' +
      '<span>第 ' + page + ' / ' + d.pages + ' 页（共 ' + fmtNum(d.total) + ' 人）</span>' +
      '<button class="btn sm" ' + (page >= d.pages ? "disabled" : "") + ' onclick="loadVotersPage(' + (page + 1) + ')">下一页</button>' +
      '</div>';
    el.innerHTML = html;
    state.votersPage = page;
  } catch (e) {
    el.innerHTML = '<div class="muted small">加载失败：' + esc(e.message) + '</div>';
  }
}

/* ---- 模拟投票 ---- */
function renderSimulate(body, e) {
  var html = '<div class="card">';
  html += '<h3>模拟投票</h3>';
  if (e.status !== "voting") {
    html += '<div class="muted">请先点击「▶ 开始投票」进入投票阶段，再进行模拟投票。</div>';
  } else if (!e.candidates.length) {
    html += '<div class="muted">没有候选人。</div>';
  } else if (e.voter_count === 0) {
    html += '<div class="muted">请先在「选民」页生成选民。</div>';
  } else {
    html += '<div class="muted small">按候选人的相对权重与选区偏好模拟真实投票行为（含弃权与无效票）。' +
      '可以分多批执行，实时查看计票变化。</div>';
    html += '<div class="mt16"><b>候选人偏好权重</b>' +
      '<div class="small muted">数值越高，该候选人越受欢迎</div>';
    e.candidates.forEach(function (c) {
      html += '<div class="slider-row">' +
        '<span class="cname" style="color:' + esc(c.color) + '">● ' + esc(c.name) + '</span>' +
        '<input type="range" id="w_' + c.id + '" min="0" max="10" step="0.5" value="5" ' +
        'oninput="document.getElementById(\'wv_' + c.id + '\').textContent=this.value">' +
        '<span class="cval" id="wv_' + c.id + '">5</span></div>';
    });
    html += '</div>';
    html += '<div class="row mt16">' +
      '<div class="field"><label>弃权率</label>' +
      '<input id="s_abstain" type="number" min="0" max="0.9" step="0.01" value="' + e.abstain_rate + '"></div>' +
      '<div class="field"><label>无效票率</label>' +
      '<input id="s_invalid" type="number" min="0" max="0.5" step="0.01" value="' + e.invalid_rate + '"></div>' +
      '<div class="field"><label>每批票数</label>' +
      '<select id="s_batch">' + [[500, "500"], [2000, "2 千"], [5000, "5 千"], [10000, "1 万"]].map(function (o) {
        return '<option value="' + o[0] + '">' + o[1] + '</option>';
      }).join("") + '</select>' +
      '<div class="hint">批次越小，趋势动画越细</div></div>' +
      '</div>';
    html += '<div class="flex mt16">' +
      '<button class="btn green" id="sim_btn" onclick="runSimulate()">▶ 开始模拟投票</button>' +
      '<span class="muted small" id="sim_status"></span></div>' +
      '<div class="progress mt8"><div id="sim_bar"></div></div>';
  }
  html += '</div>';
  if (e.status === "voting" && e.vote_count > 0) {
    html += '<div class="card mt16"><h3>实时趋势（累计票数）</h3>' +
      '<div class="chart-wrap"><canvas id="c_trend" class="chart" height="240"></canvas></div>' +
      '<div class="small muted mt8">每次模拟批次追加一个数据点。</div></div>';
  }
  body.innerHTML = html;
  if (e.status === "voting" && e.vote_count > 0) {
    // 若趋势序列为空（例如从演示选举直接进入），用当前计票初始化单点
    if (!simSeries.length) {
      e.overview.tally.forEach(function (t) {
        simSeries.push({ id: t.id, label: t.name, color: t.color, p: [t.votes] });
      });
    }
    drawTrend();
  }
}

async function runSimulate() {
  var e = state.election;
  var btn = document.getElementById("sim_btn");
  if (btn) btn.disabled = true;
  var status = document.getElementById("sim_status");
  var bar = document.getElementById("sim_bar");
  var weights = {};
  e.candidates.forEach(function (c) {
    weights[c.id] = parseFloat(document.getElementById("w_" + c.id).value) || 0;
  });
  var abstain = parseFloat(document.getElementById("s_abstain").value) || 0;
  var invalid = parseFloat(document.getElementById("s_invalid").value) || 0;
  var batch = parseInt(document.getElementById("s_batch").value, 10) || 5000;
  var done = false;
  var batchNo = 0;
  while (!done && !state.abortSim) {
    batchNo++;
    if (status) status.textContent = "正在模拟第 " + batchNo + " 批…";
    var r;
    try {
      r = await apiJson("POST", "/api/elections/" + e.id + "/simulate", {
        batch: batch, weights: weights, abstain_rate: abstain, invalid_rate: invalid
      });
    } catch (err) {
      toast(err.message, "error");
      break;
    }
    if (bar) {
      var total = r.overview.total_voters || 1;
      bar.style.width = Math.min(100, Math.round(r.overview.voted / total * 100)) + "%";
    }
    // 记录趋势（按候选人 id 稳定匹配，避免排名变化导致串线）
    r.overview.tally.forEach(function (t) {
      var found = null;
      for (var si = 0; si < simSeries.length; si++) {
        if (simSeries[si].id === t.id) { found = simSeries[si]; break; }
      }
      if (!found) {
        found = { id: t.id, label: t.name, color: t.color, p: [] };
        simSeries.push(found);
      }
      found.p.push(t.votes);
    });
    drawTrend();
    if (status) {
      status.textContent = r.message + "（有效票 " + fmtNum(r.overview.valid) + "）";
    }
    done = r.done;
    if (!done) await sleep(280);
  }
  state.abortSim = false;
  if (btn) btn.disabled = false;
  if (status && done) status.textContent = "✅ " + status.textContent;
  await loadElection();
  if (state.tab === "simulate") renderSimulate(document.getElementById("tab-body"), state.election);
}

function drawTrend() {
  var cv = document.getElementById("c_trend");
  if (!cv) return;
  var series = simSeries.map(function (s) { return { label: s.label, color: s.color, p: s.p.slice() }; });
  lineChart(cv, series, {});
}

/* ---- 审计 ---- */
function renderAudit(body, e) {
  body.innerHTML = '<div class="card"><h3>审计日志</h3><div id="audit-list">' +
    '<div class="muted small">加载中…</div></div></div>';
  loadAudit();
}

async function loadAudit() {
  var el = document.getElementById("audit-list");
  if (!el) return;
  try {
    var d = await api("/api/elections/" + state.election.id + "/audit");
    if (!d.items.length) {
      el.innerHTML = '<div class="muted small">暂无日志</div>';
      return;
    }
    el.innerHTML = d.items.map(function (a) {
      return '<div class="audit-item"><span class="ts">' + esc(a.ts) + '</span>' +
        '<span class="action">' + esc(a.action) + '</span>' +
        '<span class="detail">' + esc(a.detail) + '</span></div>';
    }).join("");
  } catch (e) {
    el.innerHTML = '<div class="muted small">加载失败：' + esc(e.message) + '</div>';
  }
}

/* ---- 导出 ---- */
function exportCsv(kind) {
  var url = "/api/elections/" + state.election.id + "/export?kind=" + kind;
  fetch(url).then(function (r) {
    if (!r.ok) throw new Error("导出失败");
    return r.blob();
  }).then(function (blob) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "election" + state.election.id + "_" + kind + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }).catch(function (err) { toast(err.message, "error"); });
}

/* ============ 启动前检测 ============ */
(function () {
  if (location.protocol === "file:") {
    document.getElementById("app").innerHTML =
      '<div style="max-width:520px;margin:80px auto;padding:24px;' +
      'background:#1e293b;border:1px solid #334155;border-radius:12px;' +
      'color:#e2e8f0;font-family:Microsoft YaHei,sans-serif;font-size:15px;line-height:1.8">' +
      '<div style="font-size:20px;font-weight:700;margin-bottom:12px;color:#f59e0b;">⚠️ 启动方式不正确</div>' +
      '<p>你直接双击打开了 <code>index.html</code>（地址栏是 file:// 开头）。</p>' +
      '<p>本系统需要后端服务，请：</p>' +
      '<ol><li>回到 <b>election-simulator</b> 文件夹</li>' +
      '<li>双击 <b>start.bat</b>（会弹出黑色控制台窗口）</li>' +
      '<li>浏览器会自动打开 <b>http://127.0.0.1:8001</b></li></ol>' +
      '<p style="color:#94a3b8;font-size:13px;">若浏览器没自动弹出，请手动在地址栏输入 http://127.0.0.1:8001</p>' +
      '</div>';
    throw new Error("file protocol, stop here");
  }
})();

/* ============ 启动 ============ */
render();
