
"use strict";
var $ = function(id){ return document.getElementById(id); };
var esc = function(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
};
var fmt = function(v, d){
  d = (d == null) ? 1 : d;
  if (v == null || v === "" || isNaN(v)) return "—";
  return Number(v).toLocaleString("en-US", {minimumFractionDigits:0, maximumFractionDigits:d});
};
var clampPct = function(v){
  if (v == null || isNaN(v)) return null;
  v = Number(v);
  return Math.max(0, Math.min(100, v));
};
var COLORS = {gpu:"#ff7a59", ram:"#4da3ff", cpu:"#7ee081", disk:"#c792ea", temp:"#ffd166", net:"#5eead4"};
var TOKEN = (function(){
  try { return new URLSearchParams(location.search).get("token") || ""; } catch(e){ return ""; }
})();
var Q = TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "";
var histCache = [];
var histSyncPending = false, infFetchPending = false;
var infData = null, sysData = null, lastData = null;
var connState = {ok:null, lastOk:null};
var INF_OK = true;      // /api/health 修正
var GPU_AVAIL = false;  // 本机有 NVIDIA GPU(推理引擎未运行也可采样)
var HIST_AVAIL = false; // stats_log 存在历史统计
var curTab = "inf";
var isPaused = false;
var lastSampleAt = null;

function setBar(id, p){
  var el = $(id);
  if (!el) return;
  p = clampPct(p);
  el.style.width = (p == null ? 0 : p) + "%";
}

function setConn(ok, err){
  var pill = $("conn"), banner = $("banner");
  if (ok){
    connState = {ok:true, lastOk:Date.now()};
    pill.className = "pill ok";
    pill.innerHTML = '<span class="dot"></span>已连接';
    $("ov_state").textContent = isPaused ? "监控已暂停" :
      (INF_OK ? "所有遥测链路正常"
              : (GPU_AVAIL ? "推理引擎未运行 · GPU 实时采样中" : "系统监控正常 · 本机无推理模块"));
    banner.classList.add("hidden");
  } else {
    if (!connState.lastOk) connState.lastOk = Date.now();
    connState.ok = false;
    pill.className = "pill off";
    pill.innerHTML = '<span class="dot"></span>连接中断';
    $("ov_state").textContent = "遥测连接中断";
    var last = connState.lastOk
      ? new Date(connState.lastOk).toLocaleTimeString("zh-CN", {hour12:false}) : "从未";
    banner.classList.remove("hidden");
    banner.textContent = "与面板服务连接中断（" + String(err || "") + "），保留最后数据 " + last;
  }
}

/* 面板/系统运行时长（天/时/分） */
function fmtT(sec){
  if (sec == null || isNaN(sec)) return "—";
  sec = Math.max(0, Math.floor(Number(sec)));
  var d = Math.floor(sec/86400), h = Math.floor(sec%86400/3600), m = Math.floor(sec%3600/60);
  return d ? (d + "天" + h + "时") : (h ? h + "时" + m + "分" : m + "分");
}

function fmtDur(sec){
  if (sec == null || isNaN(sec)) return "—";
  sec = Math.max(0, Math.floor(Number(sec)));
  if (sec < 60) return sec + "s";
  var m = Math.floor(sec/60), s = sec % 60;
  if (m < 60) return m + "m" + (s ? " " + s + "s" : "");
  return Math.floor(m/60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
}

/* 字节数 → 人读 */
function fmtB(b){
  if (b == null || isNaN(b)) return "—";
  b = Number(b);
  if (b >= 1073741824) return (b/1073741824).toFixed(2) + " GB";
  if (b >= 1048576) return (b/1048576).toFixed(1) + " MB";
  if (b >= 1024) return (b/1024).toFixed(1) + " KB";
  return b.toFixed(0) + " B";
}

/* bits/s → 人读 */
function fmtBps(b){
  if (b == null || isNaN(b)) return "—";
  b = Number(b);
  if (b >= 1e9) return (b/1e9).toFixed(2) + " Gbps";
  if (b >= 1e6) return (b/1e6).toFixed(1) + " Mbps";
  if (b >= 1e3) return (b/1e3).toFixed(0) + " Kbps";
  return b.toFixed(0) + " bps";
}

function isLlamaProc(n){ return /llama|vllm|ollama|gpt/i.test(String(n || "")); }

function gpu0(h){
  return (h && h.gpu && h.gpu.gpus && h.gpu.gpus[0]) || null;
}
function gpuList(h){
  return (h && h.gpu && h.gpu.gpus) || [];
}
/* 多卡聚合：利用率均值 / 温度峰值 / 功耗合计 / 显存合并（单卡时数值与原口径一致） */
function aggG(h){
  var gs = gpuList(h);
  var a = {n: gs.length, util: null, memUsed: null, memTotal: null, memPct: null,
           temp: null, power: null, fans: []};
  var us = 0, un = 0, ps = 0, pn = 0;
  for (var i = 0; i < gs.length; i++){
    var g = gs[i];
    if (g.util != null){ us += Number(g.util); un++; }
    if (g.temp != null && (a.temp == null || g.temp > a.temp)) a.temp = g.temp;
    if (g.power != null){ ps += Number(g.power); pn++; }
    if (g.mem_used != null){ a.memUsed = (a.memUsed || 0) + Number(g.mem_used); }
    if (g.mem_total){ a.memTotal = (a.memTotal || 0) + Number(g.mem_total); }
    if (g.fan != null) a.fans.push(Math.round(g.fan));
  }
  if (un) a.util = us / un;
  if (pn) a.power = ps;
  if (a.memUsed != null && a.memTotal) a.memPct = a.memUsed / a.memTotal * 100;
  return a;
}
function sysof(h){ return (h && h.system) || {}; }
function memPct(h){
  var y = sysof(h);
  return (y.mem_total) ? y.mem_used / y.mem_total * 100 : null;
}

function histVals(fn){
  var out = [];
  for (var i = 0; i < histCache.length; i++){
    var v = fn(histCache[i]);
    if (v != null && !isNaN(v)) out.push(Number(v));
  }
  return out;
}

function fitCanvas(cv){
  var dpr = window.devicePixelRatio || 1;
  var W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return null;
  cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr);
  var c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  return {c:c, W:W, H:H};
}

function drawSpark(id, vals, color){
  var cv = $(id); if (!cv) return;
  var f = fitCanvas(cv); if (!f) return;
  var c = f.c, W = f.W, H = f.H;
  if (vals.length < 2) return;
  var mn = Infinity, mx = -Infinity;
  for (var i = 0; i < vals.length; i++){
    if (vals[i] < mn) mn = vals[i];
    if (vals[i] > mx) mx = vals[i];
  }
  if (mx - mn < 1e-6) mx = mn + 1;
  var pad = (mx - mn) * 0.12; mn -= pad; mx += pad;
  c.strokeStyle = color; c.lineWidth = 1.5; c.lineJoin = "round";
  c.beginPath();
  for (i = 0; i < vals.length; i++){
    var x = i / (vals.length - 1) * W;
    var y = H - 2 - (vals[i] - mn) / (mx - mn) * (H - 4);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.stroke();
  c.lineTo(W, H); c.lineTo(0, H); c.closePath();
  c.globalAlpha = 0.08; c.fillStyle = color; c.fill(); c.globalAlpha = 1;
}

/* 0-100% 折线趋势图（GPU/内存/CPU 或 CPU/内存），series: [{fn,color,fill}] */
function drawPctChart(cv, hist, legendId, series, emptyMsg){
  var f = fitCanvas(cv); if (!f) return;
  var c = f.c, W = f.W, H = f.H;
  var L = 30, R = 8, T = 10, B = 18;
  var pw = W - L - R, ph = H - T - B;
  c.strokeStyle = "rgba(148,163,184,.14)";
  c.fillStyle = "#5b6884";
  c.font = "10px sans-serif";
  c.lineWidth = 1;
  var y;
  [0,25,50,75,100].forEach(function(vv){
    y = T + ph - vv/100*ph;
    c.beginPath(); c.moveTo(L, y); c.lineTo(L + pw, y); c.stroke();
    c.fillText(String(vv), 4, y + 3);
  });
  var n = hist.length;
  if (n > 1){
    for (var k = 0; k <= 4; k++){
      var idx = Math.round(k/4*(n-1));
      var t = String(hist[idx].ts || "").slice(11, 16);
      var x = L + idx/(n-1)*pw;
      var tx = (k === 0) ? x : (k === 4 ? x - 34 : x - 17);
      c.fillText(t, tx, H - 4);
    }
    for (var si = 0; si < series.length; si++){
      var s = series[si], pts = [];
      for (var j = 0; j < n; j++){
        var val = s.fn(hist[j]);
        if (val != null && !isNaN(val)) pts.push([j, Number(val)]);
      }
      if (pts.length < 2) continue;
      c.strokeStyle = s.color; c.lineWidth = 1.8; c.lineJoin = "round"; c.lineCap = "round";
      c.beginPath();
      for (var pi = 0; pi < pts.length; pi++){
        var px = L + pts[pi][0]/(n-1)*pw;
        var py = T + ph - Math.max(0, Math.min(100, pts[pi][1]))/100*ph;
        pi ? c.lineTo(px, py) : c.moveTo(px, py);
      }
      c.stroke();
      if (s.fill){
        c.lineTo(L + pts[pts.length-1][0]/(n-1)*pw, T + ph);
        c.lineTo(L + pts[0][0]/(n-1)*pw, T + ph);
        c.closePath();
        c.globalAlpha = 0.07; c.fillStyle = s.color; c.fill(); c.globalAlpha = 1;
      }
    }
  } else {
    c.fillStyle = "#5b6884";
    c.fillText(emptyMsg || "采集中，历史不足…", L + 8, T + ph/2);
  }
  if (legendId){
    var last = hist[n-1] || {};
    var html = "";
    for (var li = 0; li < series.length; li++){
      var v = series[li].fn(last);
      html += chip(series[li].color, series[li].name,
                   (v != null && !isNaN(v)) ? Math.round(v) + " %" : "—");
    }
    $(legendId).innerHTML = html;
  }
}
function chip(color, name, val){
  return '<span class="chip"><i style="background:' + color + '"></i>' + name + " <b>" + val + "</b></span>";
}

function slotRow(sl){
  var st = sl.processing
    ? '<span class="st busy"><span class="dot"></span>生成中</span>'
    : '<span class="st idle"><span class="dot"></span>空闲</span>';
  var cp = clampPct(sl.ctx_pct); if (cp == null) cp = 0;
  var ccol = cp > 80 ? "var(--err)" : (cp > 50 ? "var(--warn)" : "var(--ram)");
  var gr = (sl.processing && sl.gen_recent_tps != null)
    ? '<b>' + sl.gen_recent_tps + "</b> t/s" : "—";
  var ga = (sl.processing && sl.gen_avg_tps != null)
    ? sl.gen_avg_tps + " t/s" : "—";
  return "<tr>" +
    "<td>" + esc(sl.id) + "</td>" +
    "<td>" + st + "</td>" +
    '<td class="mono">' + esc(sl.task == null ? "" : sl.task) + "</td>" +
    "<td>" + gr + "</td>" +
    "<td>" + ga + "</td>" +
    "<td>" + (sl.prompt_tps != null ? sl.prompt_tps + " t/s" : "—") + "</td>" +
    "<td>" + fmtDur(sl.task_elapsed) + "</td>" +
    "<td>" + (sl.remain_est != null ? "≈ " + fmtDur(sl.remain_est) : "—") + "</td>" +
    "<td>" + fmt(sl.n_decoded, 0) + "</td>" +
    '<td><div class="ctx"><span class="ctxbar"><i style="width:' + cp + "%;background:" + ccol +
      '"></i></span><span>' + fmt(sl.ctx_used, 0) + " / " + fmt(sl.ctx, 0) +
      (sl.ctx_pct != null ? " (" + sl.ctx_pct + "%)" : "") + "</span></div></td>" +
    "<td>" + (sl.speculative ? "MTP" : "—") + "</td>" +
    "</tr>";
}

/* 头部信息：无论当前在哪个 Tab 都要刷新（不依赖推理页） */
function renderHeader(s){
  var stale = (!s.t || (Date.now()/1000 - s.t) > 20);
  // 可用性随每轮快照刷新(initHealth 只跑一次,引擎启停后页首状态会滞后)
  var _L = s.llama || s.inference || {};
  INF_OK = !!(_L.online);
  GPU_AVAIL = !!(s.gpu && s.gpu.gpus && s.gpu.gpus.length);
  $("ts").textContent = s.ts + (stale ? "（数据已陈旧）" : "");
  lastSampleAt = s.t ? Number(s.t) * 1000 : Date.now();
  var host = s.host || {};
  $("uptime").textContent = "运行 " + fmtT(host.uptime_s);
  $("gname").textContent = host.hostname || "…";
  updateAge();
}

function updateAge(){
  var el = $("age"); if (!el) return;
  if (!lastSampleAt){ el.textContent = "正在获取最新遥测"; return; }
  var age = Math.max(0, Math.round((Date.now() - lastSampleAt) / 1000));
  if (isPaused) el.textContent = "刷新已暂停 · 最后采样 " + age + " 秒前";
  else if (age < 3) el.textContent = "实时数据 · 刚刚更新";
  else el.textContent = "最后采样 " + age + " 秒前";
}

/* ---------------- Tab 1: 推理页渲染 ---------------- */
function renderInf(s){
  lastData = s;
  renderHeader(s);

  var gpu = s.gpu || {};
  var gpus = (gpu.gpus && gpu.gpus.length) ? gpu.gpus : [];
  var sy = sysof(s);
  var A = aggG(s);        // 多卡聚合口径
  var multi = A.n > 1;

  // 优雅降级：没采到任何 GPU 时隐藏 GPU 卡片，内存 / CPU / 磁盘照常显示
  var noGpu = !gpus.length;
  ["card_gpu_util", "card_gpu_mem", "card_gpu_temp"].forEach(function(id){
    $(id).classList.toggle("hidden", noGpu);
  });

  // GPU 利用率（多卡=均值，extra 给出各卡数值）
  $("gpu_util").innerHTML = (A.util == null) ? 'N/A <small class="err">采集失败</small>'
    : Math.round(A.util) + " <small>%</small>" + (multi ? ' <small>' + A.n + '卡均值</small>' : "");
  setBar("gpu_util_bar", A.util);
  var utilParts = [];
  for (var ui = 0; ui < gpus.length; ui++){
    if (gpus[ui].util != null) utilParts.push("卡" + ui + " " + Math.round(gpus[ui].util) + "%");
  }
  $("gpu_util_extra").textContent = multi ? utilParts.join(" · ") : "";
  drawSpark("sp_util", histVals(function(h){ var a = aggG(h); return a.util; }), COLORS.gpu);

  // 显存（多卡=合计）
  var vu = A.memUsed, vt = A.memTotal;
  var vp = A.memPct;
  $("gpu_mem").innerHTML = (vu == null) ? "N/A"
    : fmt(vu/1024, 1) + " <small>/ " + fmt(vt/1024, 0) + " GB</small>" +
      (multi ? " <small>合计</small>" : "");
  $("gpu_mem_extra").textContent = (vp == null) ? "" : "显存利用率 " + Math.round(vp) + " %" +
    (multi ? " · " + gpus.length + " 卡合并" : "");
  setBar("gpu_mem_bar", vp);
  drawSpark("sp_vram", histVals(function(h){ var a = aggG(h); return a.memPct; }), COLORS.gpu);

  // 温度 / 功耗（多卡=峰值温度 / 合计功耗）
  $("gpu_temp").innerHTML = (A.temp == null) ? "N/A"
    : Math.round(A.temp) + " <small>°C" + (multi ? " 峰值</small>" : "</small>");
  var fanTxt = multi
    ? (A.fans.length ? " · 风扇 " + A.fans.join("/") + "%" : "")
    : ((gpus[0] && gpus[0].fan != null) ? " · 风扇 " + Math.round(gpus[0].fan) + "%" : "");
  $("gpu_extra").textContent = ((A.power != null)
    ? "功耗 " + Math.round(A.power) + " W" + (multi ? "（" + A.n + " 卡合计）" : "") : "") + fanTxt;
  drawSpark("sp_temp", histVals(function(h){ var a = aggG(h); return a.temp; }), COLORS.temp);

  // 内存
  $("ram").innerHTML = fmt(sy.mem_used/1024, 1) + " <small>/ " + fmt(sy.mem_total/1024, 0) + " GB</small>";
  $("ram_extra").textContent = (sy.mem_total ? Math.round(memPct(s)) : 0) + " %";
  setBar("ram_bar", memPct(s));
  drawSpark("sp_ram", histVals(memPct), COLORS.ram);

  // CPU
  $("cpu").innerHTML = Math.round(sy.cpu_percent || 0) + " <small>%</small>";
  setBar("cpu_bar", sy.cpu_percent);
  drawSpark("sp_cpu", histVals(function(h){ return sysof(h).cpu_percent; }), COLORS.cpu);

  // 磁盘（取根分区，完整列表在系统页）
  var disks = sy.disks || [], root = null;
  for (var di = 0; di < disks.length; di++){
    if (disks[di].mount === "/"){ root = disks[di]; break; }
  }
  if (!root && disks.length) root = disks[0];
  if (root && root.total){
    $("disk_label").textContent = "磁盘 " + root.mount;
    $("disk").innerHTML = fmtB(root.used) + " <small>/ " + fmtB(root.total) + "</small>";
    var dp = (root.used_pct != null) ? root.used_pct : (root.used/root.total*100);
    $("disk_extra").textContent = "可用 " + fmtB(root.avail);
    setBar("disk_bar", dp);
  }

  // 多 GPU
  var mg = $("multi_gpu_panel");
  if (gpus.length > 1){
    mg.classList.remove("hidden");
    $("gpus_tbody").innerHTML = gpus.map(function(g, i){
      var tTxt = (g.temp == null) ? "—" : Math.round(g.temp) + "°C";
      var tCls = (g.temp != null && g.temp > 85) ? ' class="err"' :
                 ((g.temp != null && g.temp > 75) ? ' style="color:var(--warn)"' : "");
      return "<tr><td><b>GPU " + (g.index != null ? g.index : i) + "</b></td>" +
        "<td>" + esc(g.name) + "</td>" +
        "<td>" + (g.util == null ? "—" : Math.round(g.util) + "%") + "</td>" +
        "<td>" + ((g.mem_used != null) ? fmt(g.mem_used/1024, 1) + " / " + fmt(g.mem_total/1024, 0) + " GB" : "—") + "</td>" +
        "<td" + tCls + ">" + tTxt + "</td>" +
        "<td>" + (g.power == null ? "—" : Math.round(g.power) + " W") + "</td>" +
        "<td>" + (g.fan == null ? "—" : Math.round(g.fan) + "%") + "</td></tr>";
    }).join("");
  } else {
    mg.classList.add("hidden");
  }

  // GPU 进程（谁在用卡；多卡同 PID = TP 跨卡，卡列给出所在卡号）
  var gp = gpu.processes || [];
  var gpPanel = $("gpuproc_panel");
  if (gpPanel){
    if (gp.length){
      gpPanel.classList.remove("hidden");
      $("gpuproc_n").textContent = "占用显存的计算任务 · " + gp.length + " 个";
      $("gpuproc_tbody").innerHTML = gp.map(function(p){
        var nm = String(p.name || "").split(/[\\/]/).pop();
        var tag = isLlamaProc(nm) ? '<span class="tag">推理</span>' : "";
        var gpuTxt = p.gpu ? "GPU " + esc(p.gpu) : "—";
        return '<tr><td data-th="PID">' + esc(p.pid) + '</td><td data-th="进程">' + esc(nm) + tag +
          '</td><td data-th="卡">' + gpuTxt +
          '</td><td data-th="显存 MB">' + fmt(p.mem, 0) + "</td></tr>";
      }).join("");
    } else {
      gpPanel.classList.add("hidden");
    }
  }
  $("hardware_grid").classList.toggle("single", gpus.length <= 1 || !gp.length);

  // 推理引擎（llama.cpp slots 或 OpenAI 兼容引擎如 fastllm）
  var L = s.llama || {};
  var engKind = L.kind || "llamacpp";
  $("llm_title").textContent = engKind === "vllm" ? "vLLM 推理" :
    (engKind === "fastllm" ? "fastllm 推理" :
     (engKind === "llamacpp" ? "llama.cpp 推理" : "推理引擎 · OpenAI 兼容接口"));
  var lp = $("llama_pill");
  if (L.error || !L.online){
    lp.className = "pill off";
    lp.innerHTML = '<span class="dot"></span>离线';
  } else {
    lp.className = "pill ok";
    lp.innerHTML = '<span class="dot"></span>在线';
  }
  $("llama_meta").textContent = (L.error) ? "" :
    ((engKind !== "llamacpp")
      ? ((L.model ? "模型 " + L.model + " · " : "") + (L.url || ""))
      : ("忙碌 slot " + L.busy + " / " + L.total + " · " + (L.url || "")));
  var busy = (L.error) ? 0 : (L.busy || 0);
  var pb = L.probe || {};
  var px = L.proxy || {};
  var pxOn = !!(px.enabled);
  var realTps = (engKind === "vllm" && L.telemetry_source === "engine" && L.tot_recent_tps != null)
    ? L.tot_recent_tps : ((pxOn && px.recent_tps != null) ? px.recent_tps : null);
  var tpsSource = (engKind === "vllm" && L.telemetry_source === "engine" && L.tot_recent_tps != null)
    ? "引擎" : (px.recent_est ? "估算" : "代理");
  var noteTxt = "";
  if (engKind !== "llamacpp"){
    $("ov_tps").innerHTML = realTps != null
      ? (tpsSource === "估算" ? "≈ " : "") + fmt(realTps, 1) + " <small>tok/s " + tpsSource + "</small>"
      : (pb.tps != null && !pb.busy ? fmt(pb.tps, 1) + " <small>tok/s 探测</small>" : '— <small>tok/s</small>');
  } else {
    $("ov_tps").innerHTML = (busy && L.tot_recent_tps != null)
      ? fmt(L.tot_recent_tps, 1) + " <small>tok/s</small>" : '— <small>tok/s</small>';
  }
  $("ov_gpu").innerHTML = (A.util != null)
    ? Math.round(A.util) + ' <small>% · ' + fmt(vp, 0) + '% 显存' + (multi ? "（合计）" : "") + '</small>' : '—';
  if (engKind !== "llamacpp"){
    $("ov_slots").innerHTML = L.running != null
      ? fmt(L.running, 0) + ' <small>执行中' +
        (L.waiting != null ? ' · ' + fmt(L.waiting, 0) + ' 排队' : '') + '</small>'
      : (pxOn ? fmt(px.in_flight, 0) + ' <small>代理在途</small>' : '—');
  } else {
    $("ov_slots").innerHTML = (L.total != null)
      ? busy + ' <small>/ ' + L.total + '</small>' : '—';
  }
  var chips;
  if (engKind !== "llamacpp"){
    if (pxOn){
      chips = chip(COLORS.net, "输出速度(" + tpsSource + ")", realTps != null ?
                   (tpsSource === "估算" ? "≈ " : "") + realTps + " t/s" : "—")
        + chip("#7db8ff", "请求", fmt(px.reqs, 0) + " 次 · 生成 " + fmtTok(px.sess_c) + " tok")
        + ((px.streams && px.streams.length > 1)
            ? chip("#b48eff", "并发分路(估算)", px.streams.map(function (s) { return "≈" + s.tps + " (" + s.secs + "s)"; }).join(" + "))
            : "");
      noteTxt = "逐请求表只显示经代理的请求；引擎统计包含直连请求。生成中 token 为字符折算估算，最终用量以响应 usage 为准。";
    } else {
      chips = chip("#7db8ff", "模型", esc(L.model || "—"));
      noteTxt = "没有代理逐请求记录；引擎支持的汇总指标仍会显示。";
    }
    if (L.running != null) chips += chip(COLORS.net, "引擎执行", fmt(L.running, 0));
    if (L.waiting != null) chips += chip(COLORS.temp, "引擎排队", fmt(L.waiting, 0));
    if (L.kv_cache_pct != null) chips += chip(COLORS.ram, "KV 缓存占用", fmt(L.kv_cache_pct, 1) + "%");
    if (L.context_limit != null) chips += chip("#7db8ff", "单请求上限", fmt(L.context_limit, 0) + " tok");
  } else {
    chips = chip(COLORS.net, "总输出速度", (busy && L.tot_recent_tps != null) ? L.tot_recent_tps + " t/s" : "—")
      + chip(COLORS.net, "总平均速度", (busy && L.tot_avg_tps != null) ? L.tot_avg_tps + " t/s" : "—")
      + chip(COLORS.temp, "总 Prompt", (L.tot_prompt_tps != null && L.tot_prompt_tps > 0) ? L.tot_prompt_tps + " t/s" : "—")
      + chip("#7db8ff", "观察生成", fmt(L.sess_decoded, 0) + " tok");
  }
  $("llama_chips").innerHTML = L.error ? "" : chips;
  $("llama_note").style.display = (engKind !== "llamacpp" && !L.error) ? "block" : "none";
  $("llama_note").textContent = noteTxt;
  $("ov_slots_label").textContent = (engKind !== "llamacpp") ? "请求" : "活跃 Slot";
  var activeRows = pxOn && px.active_requests ? px.active_requests : [];
  $("active_requests_wrap").style.display = (engKind !== "llamacpp" && !L.error) ? "block" : "none";
  $("active_requests_tbody").innerHTML = activeRows.length ? activeRows.map(function(r){
    return "<tr><td class=\"mono\">" + esc(r.id) + "</td><td>代理在途</td><td>—</td><td>" +
      (r.output_est != null ? "≈ " + fmt(r.output_est, 0) : "—") + "</td><td>—" +
      (L.context_limit != null ? " / " + fmt(L.context_limit, 0) : "") +
      "</td><td>" + fmt(r.secs, 1) + " s</td></tr>";
  }).join("") : '<tr><td colspan="6" class="dim">没有经代理的活动请求；引擎汇总可能包含直连请求</td></tr>';
  var ecmd = L.engine_cmd || "";
  $("llama_cmd").style.display = ecmd ? "block" : "none";
  $("llama_cmd").textContent = ecmd ? ("引擎参数 " + ecmd) : "";
  var rq = (pxOn && !L.error && px.recent) ? px.recent : [];
  $("reqlog_wrap").style.display = rq.length ? "block" : "none";
  $("reqlog_tbody").innerHTML = rq.map(function(r){
    var sp = (r.ct != null && r.rtt > 0) ? (r.ct / r.rtt) : null;
    var hitPct = (r.pt > 0) ? Math.round((r.cache || 0) / r.pt * 100) + " %" : "—";
    var tStr = "—";
    try { tStr = new Date(r.t * 1000).toLocaleTimeString("zh-CN", {hour12: false}); } catch (e) {}
    return "<tr><td>" + tStr + "</td><td>" + fmt(r.ct, 0) + "</td>" +
      "<td>" + (r.rtt != null ? fmt(r.rtt, 1) + " s" : "—") + "</td>" +
      "<td>" + (sp ? fmt(sp, 1) + " t/s" : "—") + "</td>" +
      "<td>" + hitPct + "</td></tr>";
  }).join("");
  drawSpark("sp_llama", histVals(function(h){
    var ll = h.llama;
    return (ll && ll.tot_recent_tps != null) ? ll.tot_recent_tps : null;
  }), COLORS.net);
  var tb = $("slots_tbody");
  $("slots_wrap").style.display = (engKind !== "llamacpp") ? "none" : "block";
  if (engKind !== "llamacpp"){
    tb.innerHTML = "";
  } else if (L.error){
    tb.innerHTML = '<tr><td colspan="11" class="err">' +
      (L.error === "disabled" ? "推理引擎未运行" : ("连接失败: " + esc(L.error))) + "</td></tr>";
  } else if (!L.slots || !L.slots.length){
    tb.innerHTML = '<tr><td colspan="11" class="dim">无 slot</td></tr>';
  } else {
    tb.innerHTML = L.slots.map(slotRow).join("");
  }

  // 主趋势图：多卡=各卡利用率分线，单卡=单 GPU 线；叠加内存 / CPU
  var GPU_LINE_COLORS = ["#ff7a59", "#c792ea", "#5eead4", "#fbc85b"];
  var infSeries = [];
  var gi, idx;
  if (multi){
    for (gi = 0; gi < Math.min(gpus.length, GPU_LINE_COLORS.length); gi++){
      idx = gi;
      infSeries.push({
        fn:(function(k){ return function(h){
          var gs = gpuList(h);
          return (gs[k] && gs[k].util != null) ? gs[k].util : null;
        }; })(idx),
        color: GPU_LINE_COLORS[idx % GPU_LINE_COLORS.length],
        fill: idx === 0, name: "GPU" + idx
      });
    }
  } else {
    infSeries.push({fn:function(h){ var g = gpu0(h); return g ? g.util : null; },
                    color:COLORS.gpu, fill:true, name:"GPU"});
  }
  infSeries.push({fn:memPct, color:COLORS.ram, name:"内存"});
  infSeries.push({fn:function(h){ return sysof(h).cpu_percent; }, color:COLORS.cpu, name:"CPU"});
  drawPctChart($("chart"), histCache, "legend", infSeries);

  // 采样记录（多卡时 GPU 列 = 各卡利用率，显存合计 / 温度峰值）
  $("log_tbody").innerHTML = histCache.slice(-15).reverse().map(function(h){
    var a = aggG(h);
    var gs = gpuList(h);
    var utilTxt = gs.length > 1
      ? gs.map(function(g){ return (g.util == null) ? "—" : Math.round(g.util); }).join(" / ")
      : fmt(a.util, 0);
    return "<tr><td>" + esc(h.ts) + "</td><td>" + utilTxt + "</td><td>" + fmt(a.memUsed, 0) +
      "</td><td>" + fmt(a.temp, 0) + "</td><td>" + fmt(memPct(h), 0) + "</td><td>" +
      fmt(sysof(h).cpu_percent, 0) + "</td></tr>";
  }).join("");
}

/* ---------------- Tab 2: 系统页渲染 ---------------- */
function corebar(cores){
  var el = $("corebar"); if (!el) return;
  if (el.childElementCount !== cores.length){
    var h = "";
    for (var i = 0; i < cores.length; i++) h += "<i></i>";
    el.innerHTML = h;
  }
  var kids = el.children;
  for (var j = 0; j < kids.length; j++){
    var v = cores[j] || 0;
    kids[j].style.height = Math.max(2, Math.min(100, v)) + "%";
    kids[j].title = "CPU" + j + ": " + v + "%";
    kids[j].className = v > 85 ? "crit" : (v > 60 ? "hot" : "");
  }
}

function renderSys(s){
  sysData = s;
  var host = s.host || {};
  var sy = sysof(s);
  if (!INF_OK && !GPU_AVAIL){
    $("ov_state").textContent = isPaused ? "监控已暂停" : "系统监控正常 · 本机无推理模块";
    $("ov_tps").innerHTML = '— <small>未部署推理</small>';
    $("ov_gpu").innerHTML = Math.round(sy.cpu_percent || 0) + ' <small>% CPU</small>';
    $("ov_slots").innerHTML = (sy.core_count || '—') + ' <small>线程</small>';
    var ol = $("ov_slots_label"); if (ol) ol.textContent = "线程";
  } else if (!INF_OK){
    $("ov_state").textContent = isPaused ? "监控已暂停" : "推理引擎未运行 · GPU 实时采样中";
  }

  $("host_name").textContent = host.hostname || "—";
  $("host_ip").textContent = host.ip || "—";
  $("host_uptime").textContent = fmtT(host.uptime_s);
  var phys = s.phys_cores || 0, cc = sy.core_count || 0;
  var ctxt = (cc ? cc + " 线程" : "—");
  if (phys) ctxt += " · 物理 " + phys + " 核 · " + (cc > phys ? "HT 开" : "HT 关");
  $("host_cores").textContent = ctxt;
  $("host_load").textContent = (sy.load || []).join(" / ");

  // CPU
  $("syscpu").innerHTML = Math.round(sy.cpu_percent || 0) + " <small>%</small>";
  $("sys_load").textContent = (sy.load || []).join(" / ");
  $("cpu_n").textContent = (sy.core_count || "—") + " 核";
  setBar("cpu_bar_sys", sy.cpu_percent);
  drawSpark("sp_syscpu", histVals(function(h){ return sysof(h).cpu_percent; }), COLORS.cpu);
  corebar(sy.cores || []);

  // 内存 / swap
  var mp = memPct(s);
  $("sysmem").innerHTML = fmt(sy.mem_used/1024, 1) + " <small>/ " + fmt(sy.mem_total/1024, 0) + " GB</small>";
  $("mem_extra").textContent = (mp != null ? Math.round(mp) : 0) + " %";
  setBar("mem_bar_sys", mp);
  drawSpark("sp_sysmem", histVals(memPct), COLORS.ram);
  $("swapline").textContent = sy.swap_total
    ? (fmt(sy.swap_used/1024, 1) + " / " + fmt(sy.swap_total/1024, 0) + " GB")
    : "未启用";

  // 网络
  $("rx").textContent = fmtBps(sy.net_rx_bps);
  $("tx").textContent = fmtBps(sy.net_tx_bps);
  drawSpark("sp_net", histVals(function(h){ return sysof(h).net_rx_bps; }), COLORS.net);
  $("rxt").textContent = fmtB(sy.rx_total);
  $("txt").textContent = fmtB(sy.tx_total);

  // 磁盘
  $("disks_box").innerHTML = (sy.disks && sy.disks.length)
    ? sy.disks.map(function(d){
        var pct = (d.used_pct != null) ? d.used_pct : (d.total ? d.used/d.total*100 : 0);
        var cls = pct > 90 ? "crit" : (pct > 80 ? "warn" : "");
        return '<div class="dbar"><div class="lbl"><span class="mono">' + esc(d.mount) +
          '</span><span class="dim">' + Math.round(pct*10)/10 + '% 已用 · 余 ' + fmtB(d.avail) +
          ' / ' + fmtB(d.total) + '</span></div>' +
          '<div class="track"><div class="fill ' + cls + '" style="width:' +
          clampPct(pct) + '%"></div></div></div>';
      }).join("")
    : '<span class="dim">无磁盘数据</span>';

  // TOP 进程
  $("top_tbody").innerHTML = (sy.top_procs && sy.top_procs.length)
    ? sy.top_procs.map(function(p){
        return '<tr><td data-th="PID">' + p.pid + '</td>' +
          '<td data-th="进程">' + esc(p.name) + (isLlamaProc(p.name) ? '<span class="tag">推理</span>' : "") + '</td>' +
          '<td data-th="CPU%">' + fmt(p.cpu, 1) + '</td>' +
          '<td data-th="MEM%">' + fmt(p.mem, 1) + '</td>' +
          '<td data-th="内存">' + fmt(p.rss_mb, 0) + ' MB</td></tr>';
      }).join("")
    : '<tr><td colspan="5" class="dim">无数据</td></tr>';

  // 每核占用 + 温度（半宽双卡，网格排布；无数据隐藏对应卡）
  var cc = sy.cores;
  if (cc && cc.length){
    $("coreuse_panel").classList.remove("hidden");
    var cmx = Math.max.apply(null, cc);
    $("coreuse_max").textContent = "峰值 " + cmx + "%";
    $("coreuse_box").innerHTML = cc.map(function(v, i){
      var cls = v > 90 ? "crit" : (v > 70 ? "hot" : "ok");
      var w = Math.max(2, Math.min(100, v));
      return '<div class="corechip ' + cls + '"><span class="cl">Core ' + i + '</span><b>' + v + '%</b><i class="bar" style="width:' + w + '%"></i></div>';
    }).join("");
  } else {
    $("coreuse_panel").classList.add("hidden");
  }

  // 温度（无数据隐藏整个卡）
  var tp = sy.temps;
  if (tp && tp.length){
    $("temps_panel").classList.remove("hidden");
    var mx = Math.max.apply(null, tp.map(function(t){ return t.temp; }));
    var mcls = mx > 85 ? "crit" : (mx > 70 ? "hot" : "");
    $("temps_max").textContent = "最高 " + mx + "°C";
    $("temps_max").className = "legend " + mcls;
    $("temps_box").innerHTML = tp.map(function(t){
      var cls = t.temp > 85 ? "crit" : (t.temp > 70 ? "hot" : "ok");
      var w = Math.max(2, Math.min(100, t.temp));
      return '<div class="corechip ' + cls + '"><span class="cl">' + esc(t.label) + '</span><b>' + t.temp + '°C</b><i class="bar" style="width:' + w + '%"></i></div>';
    }).join("");
  } else {
    $("temps_panel").classList.add("hidden");
  }

  // 系统趋势：CPU / 内存
  drawPctChart($("syschart"), histCache, "sys_legend", [
    {fn:function(h){ return sysof(h).cpu_percent; }, color:COLORS.cpu, fill:true, name:"CPU"},
    {fn:memPct, color:COLORS.ram, name:"内存"}
  ], "采集中，历史不足…");
}

/* ---------------- 工作统计 ---------------- */
var STATS_W = ["24h", "7d", "30d", "1y", "3y"];
var STATS_LABEL = {"24h":"24 小时","7d":"7 天","30d":"30 天","1y":"1 年","3y":"3 年"};
var STATS_RANGE_S = {"24h":86400,"7d":604800,"30d":2592000,"1y":31536000,"3y":94608000};
var statsData = null;
var statsRange = "24h";
var statsMetric = "tok";
var statsGeom = null;

function fmtTok(v){
  if (v == null || isNaN(v)) return "—";
  v = Number(v);
  if (v >= 1e9) return (v/1e9).toFixed(2) + " G";
  if (v >= 1e6) return (v/1e6).toFixed(2) + " M";
  if (v >= 1e4) return (v/1e3).toFixed(1) + " k";
  return fmt(v, 0);
}

function fetchStats(){
  if (isPaused) return;   // 暂停刷新时工作统计一并冻结
  fetch("/api/stats" + Q, {cache:"no-store"})
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){ if (d){ statsData = d; renderStats(); } })
    .catch(function(){});
}

function statCard(color, label, val, sub, primary){
  return '<div class="card' + (primary ? ' stat-primary' : '') + '" style="--c:' + color + '"><div class="label">' + esc(label) +
    '</div><div class="value">' + val + '</div>' +
    (sub ? '<div class="extra">' + sub + '</div>' : '') + '</div>';
}

function analysisCard(label, val, sub){
  return '<div class="analysis-card"><div class="alabel">' + esc(label) +
    '</div><div class="avalue">' + val + '</div><div class="asub">' + esc(sub || '') + '</div></div>';
}

function renderAnalysis(w){
  w = w || {};
  var energyReady = (w.energy_coverage_pct || 0) >= 80;
  // 能效分子与"生成 token"卡片同口径:llama.cpp 计数器 + 代理记账
  var generated = (w.tok_gen || 0) + (w.proxy_tok_gen || 0);
  var efficiency = (energyReady && generated && w.energy_kwh) ? generated / w.energy_kwh : null;
  $("analysis_cards").innerHTML =
    analysisCard("P95 实时输出",
      ((w.tps_real_p95 != null ? w.tps_real_p95 : w.tps_p95) != null)
        ? fmt(w.tps_real_p95 != null ? w.tps_real_p95 : w.tps_p95, 1) + ' t/s' : "—",
      (w.tps_real_avg != null ? "真实均值 " + fmt(w.tps_real_avg, 1) + " t/s · "
                              : (w.tps_p95 != null && w.tps_real_p95 == null ? "含探测样本 · " : ""))
        + (w.tps_peak != null ? "峰值 " + fmt(w.tps_peak, 1) + " t/s" : "等待忙碌样本")) +
    analysisCard("GPU 能耗估算", w.energy_kwh != null ? fmt(w.energy_kwh, 3) + ' kWh' : "—", efficiency ? fmtTok(efficiency) + " tok/kWh（窗口生成量÷GPU总能耗，含空闲耗电）" : "功耗样本覆盖 " + fmt(w.energy_coverage_pct, 1) + "%") +
    analysisCard("峰值 / 平均功耗", w.power_max != null ? fmt(w.power_max, 0) + ' W' : "—", w.power_avg != null ? "平均 " + fmt(w.power_avg, 0) + " W" : "等待功耗样本") +
    analysisCard("数据覆盖", w.coverage_pct != null ? fmt(w.coverage_pct, 1) + ' %' : "—", fmt(w.samples, 0) + " 个原始样本");
}

function renderStats(){
  var d = statsData;
  if (!d || !d.ready){
    $("stats_cards").innerHTML = '<div class="dim" style="padding:8px">统计初始化中…</div>';
    $("analysis_cards").innerHTML = "";
    return;
  }
  $("stats_meta").textContent = "数据自 " + (d.data_from || "—") + " 开始记录 · 更新于 " + (d.updated_at || "—");
  var tabs = $("stats_tabs");
  tabs.innerHTML = "";
  STATS_W.forEach(function(k){
    var b = document.createElement("button");
    b.className = "stab" + (k === statsRange ? " on" : "");
    b.textContent = STATS_LABEL[k];
    b.onclick = function(){ statsRange = k; renderStats(); };
    tabs.appendChild(b);
  });
  var mt = $("stats_metric");
  mt.innerHTML = "";
  [["tok", "Token"], ["busy", "推理时长"], ["tps", "平均吞吐"], ["energy", "能耗"]].forEach(function(p){
    var b = document.createElement("button");
    b.className = "stab" + (statsMetric === p[0] ? " on" : "");
    b.textContent = p[1];
    b.onclick = function(){ statsMetric = p[0]; renderStats(); };
    mt.appendChild(b);
  });
  var w = (d.windows || {})[statsRange] || {};
  var rangeS = STATS_RANGE_S[statsRange];
  var pctOf = function(s){
    return (s != null && rangeS) ? "占 " + Math.round(s/rangeS*1000)/10 + " %" : "";
  };
  var pIn = w.proxy_tok_prompt || 0, pCache = w.proxy_cache || 0, pGen = w.proxy_tok_gen || 0;
  var inVal = null, cacheSub = "";
  if (w.tok_prompt != null || pIn){
    var calcTok = (w.tok_prompt || 0);
    var legacyCache = w.tok_cached || 0;
    var cachedTok = legacyCache + pCache;
    // llama.cpp 的 prompt/cache 是两个独立计数器；代理 usage.prompt_tokens 已包含 cached_tokens。
    inVal = calcTok + legacyCache + pIn;
    if (inVal > 0 && cachedTok <= inVal){
      var hitPct = Math.round(cachedTok / inVal * 1000) / 10;
      cacheSub = "缓存命中 " + fmtTok(cachedTok) + " · 占输入 " + hitPct + " %";
    } else if (cachedTok > inVal){
      cacheSub = "缓存计数待校准";
    }
  }
  var genSub;
  if (pGen > 0 && w.proxy_gen_s >= 120){
    // 累计请求时长够长才给平均,避免字段引入初期分子分母不对称(旧 token 无配对耗时)
    genSub = "代理平均 " + fmt(pGen / w.proxy_gen_s, 1) + " t/s · " + fmtTok(pGen) + " tok";
  } else if (pGen > 0){
    genSub = "代理记账 " + fmtTok(pGen) + " tok（平均速度累计中）";
  } else if (w.avg_tps){
    genSub = "平均 " + w.avg_tps + " t/s";
  } else {
    genSub = "";
  }
  $("stats_cards").innerHTML =
    statCard("#ffd166", "输入 token",
      (inVal != null ? fmtTok(inVal) : "—"),
      cacheSub || (w.tok_prompt != null ? "实际计算 " + fmtTok(w.tok_prompt) : ""), true) +
    statCard("#5eead4", "生成 token",
      fmtTok((w.tok_gen || 0) + pGen), genSub, true) +
    statCard("#5eead4", "投机接受率", (w.spec_acc != null ? w.spec_acc + " %" : "—"), "MTP 草稿命中") +
    statCard("#7db8ff", "推理忙碌", fmtDur(w.busy_s), pctOf(w.busy_s)) +
    statCard("#ff7a59", "GPU 活跃", fmtDur(w.gpu_active_s), pctOf(w.gpu_active_s)) +
    statCard("#7ee081", "平均 GPU 利用", (w.gpu_util_avg != null ? w.gpu_util_avg + " %" : "—"), "") +
    statCard("#c792ea", "峰值温度", (w.temp_max != null ? Math.round(w.temp_max) + " °C" : "—"), "");
  renderAnalysis(w);
  var buckets;
  if (statsRange === "24h") buckets = (d.buckets || {}).hourly;
  else if (statsRange === "1y") buckets = ((d.buckets || {}).weekly || []).slice(-53);
  else if (statsRange === "3y") buckets = (d.buckets || {}).weekly;
  else buckets = ((d.buckets || {}).daily || []).slice(statsRange === "7d" ? -7 : -30);
  drawStatsChart(buckets || [], statsMetric);
}

function drawStatsChart(buckets, metric){
  var f = fitCanvas($("stats_chart")); if (!f) return;
  $("stats_tip").style.display = "none";
  var c = f.c, W = f.W, H = f.H, L = 44, R = 8, T = 12, B = 20;
  var pw = W - L - R, ph = H - T - B;
  c.strokeStyle = "rgba(148,163,184,.14)";
  c.fillStyle = "#5b6884";
  c.font = "10px sans-serif";
  c.lineWidth = 1;
  var valueOf = metric === "tok" ? function(b){ return (b.tok || 0) + (b.ptok || 0); } :
    (metric === "busy" ? function(b){ return b.busy_s || 0; } :
    (metric === "tps" ? function(b){ return b.tps || 0; } : function(b){ return b.energy_kwh || 0; }));
  var fmtV = metric === "tok" ? fmtTok : (metric === "busy" ? function(v){ return fmtDur(v); } :
    (metric === "tps" ? function(v){ return fmt(v, 1) + " t/s"; } : function(v){ return fmt(v, 3) + " kWh"; }));
  var mx = 0;
  buckets.forEach(function(b){
    var v = valueOf(b);
    if (v > mx) mx = v;
  });
  [0, 0.5, 1].forEach(function(v){
    var y = T + ph - v*ph;
    c.beginPath(); c.moveTo(L, y); c.lineTo(L + pw, y); c.stroke();
    c.fillText(fmtV(mx*v), 4, y + 3);
  });
  var n = buckets.length;
  statsGeom = n ? {L:L, bw:pw/n, n:n, buckets:buckets, bars:[]} : null;
  if (!n) return;
  if (mx <= 0){
    c.fillText("该时段暂无推理数据", L + 8, T + ph/2);
  }
  var bw = pw / n;
  buckets.forEach(function(b, i){
    var v = valueOf(b);
    var h = (v > 0 && mx > 0) ? Math.max(2, v/mx*ph) : 0;
    var bar = {x:L + i*bw + 1, y:T + ph - h, w:Math.max(1, bw - 2), h:h};
    statsGeom.bars.push(bar);
    c.fillStyle = (v > 0) ? (metric === "energy" ? "rgba(189,140,255,.85)" :
      (metric === "tps" ? "rgba(110,231,216,.85)" : "rgba(255,122,89,.85)")) : "rgba(148,163,184,.15)";
    c.fillRect(bar.x, bar.y, bar.w, bar.h);
  });
  var step = Math.max(1, Math.ceil(n/6));
  for (var i = 0; i < n; i += step){
    c.fillStyle = "#5b6884";
    c.fillText(buckets[i].label, L + i*bw, H - 4);
  }
}

/* 柱状图悬停提示 */
(function(){
  var cv = $("stats_chart"), tip = $("stats_tip");
  if (!cv || !tip) return;
  cv.addEventListener("mousemove", function(e){
    if (!statsGeom){
      tip.style.display = "none";
      cv.style.cursor = "default";
      return;
    }
    var r = cv.getBoundingClientRect();
    var px = e.clientX - r.left, py = e.clientY - r.top;
    var i = Math.floor((px - statsGeom.L) / statsGeom.bw);
    var bar = statsGeom.bars[i];
    if (!bar || !bar.h || px < bar.x - 3 || px > bar.x + bar.w + 3 ||
        py < bar.y - 5 || py > bar.y + bar.h + 5){
      tip.style.display = "none";
      cv.style.cursor = "default";
      return;
    }
    cv.style.cursor = "help";
    var b = statsGeom.buckets[i];
    tip.innerHTML = "<b>" + esc(b.label) + "</b><br>" +
      "生成 " + fmtTok((b.tok || 0) + (b.ptok || 0)) + " tok" +
      (b.ptok ? "（代理 " + fmtTok(b.ptok) + "）" : "") + "<br>" +
      "推理忙碌 " + fmtDur(b.busy_s) + "<br>" +
      "平均吞吐 " + (b.tps != null ? fmt(b.tps, 1) + " t/s" : "—") + "<br>" +
      "能耗 " + (b.energy_kwh != null ? fmt(b.energy_kwh, 3) + " kWh" : "—");
    tip.style.display = "block";
    var gap = 10, x = e.clientX + gap, y = e.clientY - tip.offsetHeight / 2;
    if (x + tip.offsetWidth + 8 > window.innerWidth) x = e.clientX - tip.offsetWidth - gap;
    tip.style.left = Math.max(8, Math.min(x, window.innerWidth - tip.offsetWidth - 8)) + "px";
    tip.style.top = Math.max(8, Math.min(y, window.innerHeight - tip.offsetHeight - 8)) + "px";
  });
  cv.addEventListener("mouseleave", function(){ tip.style.display = "none"; cv.style.cursor = "default"; });
})();

/* ---------------- Tab 切换 / 自适应 ---------------- */
function switchTab(t){
  curTab = t;
  $("tab_btn_inf").className = "tabbtn" + (t === "inf" ? " on" : "");
  $("tab_btn_sys").className = "tabbtn" + (t === "sys" ? " on" : "");
  $("tab_btn_inf").setAttribute("aria-selected", t === "inf" ? "true" : "false");
  $("tab_btn_sys").setAttribute("aria-selected", t === "sys" ? "true" : "false");
  $("tab_inf").classList.toggle("hidden", t !== "inf");
  $("tab_sys").classList.toggle("hidden", t !== "sys");
  // 隐藏时 canvas clientWidth 为 0 画不了，切换后立即用缓存重绘
  if (t === "inf" && infData) renderInf(infData);
  if (t === "sys" && sysData) renderSys(sysData);
}

function applyInference(){
  // 推理引擎未运行时,只要有 GPU 采样或历史统计,推理页照常展示:
  // GPU 实时卡片正常渲染,llama 相关字段自动呈离线态,页内横幅说明原因
  var showBody = INF_OK || GPU_AVAIL || HIST_AVAIL;
  var notice = $("inf_notice");
  if (showBody){
    $("inf_body").classList.remove("hidden");
    $("inf_empty").classList.add("hidden");
    if (!INF_OK){
      notice.classList.remove("hidden");
      notice.textContent = "推理引擎未运行 —— 以下为 GPU 实时采样与长期历史统计";
    } else {
      notice.classList.add("hidden");
    }
  } else {
    $("inf_body").classList.add("hidden");
    $("inf_empty").classList.remove("hidden");
    notice.classList.add("hidden");
    switchTab("sys");   // 无 GPU 也无历史(如 node01):默认进系统页
  }
}

function initHealth(){
  fetch("/api/health" + Q, {cache:"no-store"})
    .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function(h){
      if (h && h.interval) $("intv").textContent = String(Math.round(Number(h.interval)));
      INF_OK = !!(h && h.inference_available);
      GPU_AVAIL = !!(h && h.gpu_available);
      HIST_AVAIL = !!(h && h.inference_history);
      if (h && h.hostname) document.title = "监控面板 · " + h.hostname;
      var pill = $("inf_pill");
      if (INF_OK){
        pill.className = "pill ok";
        pill.innerHTML = '<span class="dot"></span>推理可用';
      } else {
        pill.className = "pill off";
        pill.innerHTML = '<span class="dot"></span>无推理模块';
      }
      $("ov_state").textContent = INF_OK ? "推理与系统监控就绪"
        : (GPU_AVAIL ? "推理引擎未运行 · GPU 实时采样中" : "系统监控就绪 · 本机无推理模块");
      applyInference();
    })
    .catch(function(){});
}

/* ---------------- 双计时器轮询：最新采样 2s / 完整历史每分钟校准 ---------------- */
function addHistorySample(s){
  if (!s || !s.t) return;
  var n = histCache.length;
  if (n && s.t < histCache[n-1].t) return;
  if (n && s.t === histCache[n-1].t) histCache[n-1] = s;
  else histCache.push(s);
  if (histCache.length > 900) histCache.splice(0, histCache.length - 900);
}

function syncHistory(force){
  if ((isPaused && !force) || histSyncPending) return;
  histSyncPending = true;
  var ctl = new AbortController();
  var to = setTimeout(function(){ ctl.abort(); }, 8000);
  fetch("/api/history?limit=900" + (TOKEN ? "&token=" + encodeURIComponent(TOKEN) : ""),
        {signal:ctl.signal, cache:"no-store"})
    .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function(items){
      if (Array.isArray(items)){
        histCache = items;
        addHistorySample(infData);
        if (curTab === "inf" && infData) renderInf(infData);
        if (curTab === "sys" && sysData) renderSys(sysData);
      }
    })
    .catch(function(){})
    .then(function(){ clearTimeout(to); histSyncPending = false; });
}

function tickInf(force){
  if ((isPaused && !force) || infFetchPending) return;
  infFetchPending = true;
  var ctl = new AbortController();
  var to = setTimeout(function(){ ctl.abort(); }, 5000);
  fetch("/api/latest" + Q, {signal:ctl.signal, cache:"no-store"})
  .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
  .then(function(s){
    if (!s || !s.ts) throw new Error("数据为空");
    addHistorySample(s);
    infData = s;
    renderHeader(s);
    if (curTab === "inf") renderInf(s);
    setConn(true);
  }).catch(function(e){
    setConn(false, (e && e.name === "AbortError") ? "超时" : (e && e.message || String(e)));
  }).then(function(){
    clearTimeout(to);
    infFetchPending = false;
  });
}

function tickSys(force){
  if (isPaused && !force) return;
  var ctl = new AbortController();
  var to = setTimeout(function(){ ctl.abort(); }, 8000);
  fetch("/api/latest" + Q, {signal:ctl.signal, cache:"no-store"})
    .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function(s){
      clearTimeout(to);
      if (!s || !s.ts) throw new Error("数据为空");
      if (curTab === "sys") renderSys(s);
      else sysData = s;
    })
    .catch(function(){ clearTimeout(to); });
}

$("tab_btn_inf").onclick = function(){ switchTab("inf"); };
$("tab_btn_sys").onclick = function(){ switchTab("sys"); };
$("pause_btn").onclick = function(){
  isPaused = !isPaused;
  this.classList.toggle("active", isPaused);
  this.setAttribute("aria-pressed", isPaused ? "true" : "false");
  this.textContent = isPaused ? "继续刷新" : "暂停刷新";
  if (isPaused){
    $("ov_state").textContent = "监控已暂停";
  } else {
    $("ov_state").textContent = "正在恢复实时数据…";
    tickInf(); tickSys(); syncHistory(); fetchStats();
  }
  updateAge();
};
$("refresh_btn").onclick = function(){
  tickInf(true); tickSys(true); syncHistory(true); fetchStats();
};

initHealth();
syncHistory();
tickInf();
setInterval(tickInf, 2000);
setInterval(syncHistory, 60000);
tickSys();
setInterval(tickSys, 10000);
fetchStats();
setInterval(fetchStats, 60000);
setInterval(updateAge, 1000);
window.addEventListener("resize", function(){
  if (infData) renderInf(infData);
  if (sysData) renderSys(sysData);
  if (statsData) renderStats();
});
