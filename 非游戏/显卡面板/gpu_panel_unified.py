# -*- coding: utf-8 -*-
"""
gpu_panel_unified - 统一监控面板（推理 + 系统，双分页自适应）
融合 gpu_panel_v4（GPU / llama.cpp 推理监控）与 node01_panel（纯 /proc 系统监控）：
- 推理页：GPU 多卡、显存/温度/功耗、llama.cpp slots 速度、30 分钟趋势、长期工作统计
- 系统页：每核 CPU、内存/swap、网络速率与累计、磁盘挂载点、TOP 进程、CPU 温度、运行时长
- 自适应：启动时探测 nvidia-smi 与 llama-server，两者皆无 → 推理页显示空状态且默认进系统页
- 同一份代码部署 ai-server（有 GPU + llama）与 node01（无 GPU，python3.6）
- 兼容 Python 3.6+：不用 walrus / dataclasses / capture_output / f-string；
  psutil 可选（import 放 try 里），其余纯标准库直读 /proc 与 /sys
- 采样分层：llama.cpp /slots 每 2s（token 速度要快），nvidia-smi 每 10s（重，放慢），
  系统 CPU/内存/网络每 2s，磁盘/温度/进程/IP 每 10s；组件不存在时静默降级 available:false
- 长期工作统计：每 60s 快照 token/能耗/资源基线，保留 3 年（30 天后按小时压缩）

用法:  python3 gpu_panel_unified.py [port]      默认 8081
环境变量:
  LLM_URL          llama-server 地址 (默认 http://127.0.0.1:8080)
  SAMPLE_INTERVAL  快采样周期秒 (默认 2)
  SYS_INTERVAL     GPU 慢采样周期秒 (默认 10)
  MAX_HISTORY      内存历史条数 (默认 900 ≈ 30 分钟 @2s)
  CSV_INTERVAL     CSV 落盘间隔秒 (默认 10；<=0 完全关闭 CSV 日志)
  PANEL_TOKEN      设置后 /api/* 需要 ?token=xxx 或 Authorization: Bearer xxx
                    （页面 URL 带 ?token=xxx 时前端自动带上）
  LLM_PROBE_INTERVAL  可选生成式基准探测周期秒 (默认 0=关闭；显式设置才启用)
  LLM_PROBE_TOKENS    探测请求生成的 token 数 (默认 48；仅用于测速,不计入用量)
  LLM_PROXY_PORT      LLM 透明代理端口 (默认 8082；<=0 关闭)。代理顶替原访问端口、
                       引擎挪到其他端口,客户端零改动,流量自动记账
  LLM_PROXY_HOST      代理监听地址 (默认 127.0.0.1；对外服务用 0.0.0.0)
  另支持 SCRIPT_DIR/panel_config.json 配置文件(文件优先于环境变量),键同上去下划线名
"""
import csv
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

try:
    from http.server import ThreadingHTTPServer          # py3.7+
except ImportError:
    from socketserver import ThreadingMixIn

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

try:
    import psutil                                        # 可选依赖，缺失则走 /proc
except Exception:
    psutil = None

# pythonw（.pyw）下没有控制台，sys.stdout/stderr 为 None 时 print() 会抛异常，
# 重定向到空设备保证两种启动方式都能运行（Linux 下无影响）。
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

# ---------------- 配置 ----------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 8081
BIND_HOST = os.environ.get("PANEL_HOST", "0.0.0.0")  # 与 tailscale serve 共存时绑 127.0.0.1
HOSTNAME = socket.gethostname()
LLM_URL = os.environ.get("LLM_URL", "http://127.0.0.1:8080")
try:
    SAMPLE_INTERVAL = max(1.0, float(os.environ.get("SAMPLE_INTERVAL", "2")))
except ValueError:
    SAMPLE_INTERVAL = 2.0
try:
    SYS_INTERVAL = max(2.0, float(os.environ.get("SYS_INTERVAL", "10")))  # GPU 慢采样周期
except ValueError:
    SYS_INTERVAL = 10.0
SYS_FAST_INTERVAL = 2.0   # 系统 CPU/内存/网络快采样周期
SYS_SLOW_TICKS = 5        # 每 5 个快拍做一次慢采样（磁盘/温度/进程/IP）≈ 10s
try:
    MAX_HISTORY = int(os.environ.get("MAX_HISTORY", "900"))
except ValueError:
    MAX_HISTORY = 900
MAX_HISTORY = max(60, MAX_HISTORY)
PANEL_TOKEN = os.environ.get("PANEL_TOKEN", "")
CSV_LOG = os.path.join(SCRIPT_DIR, "gpu_log_unified.csv")
CSV_MAX_BYTES = 5 * 1024 * 1024
REQUESTS_LOG = os.path.join(SCRIPT_DIR, "requests_log.jsonl")  # 代理逐请求明细
REQUESTS_MAX_BYTES = 5 * 1024 * 1024
try:
    CSV_INTERVAL = float(os.environ.get("CSV_INTERVAL", "10"))  # 秒；<=0 关闭 CSV
except ValueError:
    CSV_INTERVAL = 10.0
STATS_LOG = os.path.join(SCRIPT_DIR, "stats_log.jsonl")
try:
    STATS_INTERVAL = max(30.0, float(os.environ.get("STATS_INTERVAL", "60")))
except ValueError:
    STATS_INTERVAL = 60.0      # 长期统计采样周期秒
STATS_RETENTION_DAYS = 1096    # 3 年：30 天逐分钟，之后按小时压缩
STATS_DETAIL_DAYS = 30
START_TIME = time.time()

RECENT_WINDOW_S = 3.0  # "3s 速度"滑动窗口，对齐 llama-server 表格
RECENT_KEEP_S = 10.0   # 每个 slot 保留的 (t, n_decoded) 样本时长上限

# OpenAI 兼容引擎(fastllm 等)探测：无 /slots、无全局计数器,周期发轻量请求
# 测活性与空载速度;探测产生的 token 不计入用量统计
try:
    LLM_PROBE_INTERVAL = float(os.environ.get("LLM_PROBE_INTERVAL", "0"))
except ValueError:
    LLM_PROBE_INTERVAL = 0.0
try:
    LLM_PROBE_TOKENS = max(2, int(os.environ.get("LLM_PROBE_TOKENS", "48")))
except ValueError:
    LLM_PROBE_TOKENS = 48
LLM_PROBE_TIMEOUT = 30  # 引擎忙时探测会在队列里等,放宽超时
LLM_TPS_CAP = 500.0     # 吞吐样本物理合理性上限(工作统计过滤差分毛刺;panel_config llm_tps_cap 可改)
SERVER_VERSION = "gpuPanelUnified/3.17"   # 唯一版本源:健康接口与 HTTP 头共用


def _tps_cap():
    return LLM_TPS_CAP

# LLM 透明代理：面板在 LLM_PROXY_HOST:LLM_PROXY_PORT 起一个转发到 LLM_URL 的代理,
# 逐请求统计真实 prompt/completion token(从响应 usage 读)。所有客户端照常访问
# 原端口即可(代理顶替原端口,引擎挪到其他端口);<=0 关闭
try:
    LLM_PROXY_PORT = int(os.environ.get("LLM_PROXY_PORT", "8082"))
except ValueError:
    LLM_PROXY_PORT = 8082
LLM_PROXY_HOST = os.environ.get("LLM_PROXY_HOST", "127.0.0.1")  # 对外服务用 0.0.0.0
LLM_PROXY_TIMEOUT = 300  # 上游读空闲超时秒(长流式响应期间 chunk 间隔不会触发)

# 服务器个性化配置：SCRIPT_DIR/panel_config.json(可选,不存在则用默认/环境变量;
# 文件优先于环境变量,便于免 sudo 调整服务器侧配置)。键名与去 llm_ 前缀的环境变量一致:
# {"llm_url": "http://127.0.0.1:8079", "llm_proxy_host": "0.0.0.0", "llm_proxy_port": 8080}
_CFG_PATH = os.path.join(SCRIPT_DIR, "panel_config.json")
if os.path.exists(_CFG_PATH):
    try:
        with open(_CFG_PATH) as _f:
            _cfg = json.load(_f)
        if isinstance(_cfg, dict):
            for _k, _g in (("llm_url", "LLM_URL"), ("llm_proxy_host", "LLM_PROXY_HOST")):
                if isinstance(_cfg.get(_k), str) and _cfg[_k]:
                    globals()[_g] = _cfg[_k]
            for _k, _g in (("llm_proxy_port", "LLM_PROXY_PORT"),
                           ("llm_probe_tokens", "LLM_PROBE_TOKENS")):
                if isinstance(_cfg.get(_k), int):
                    globals()[_g] = _cfg[_k]
            if isinstance(_cfg.get("llm_probe_interval"), (int, float)):
                globals()["LLM_PROBE_INTERVAL"] = float(_cfg["llm_probe_interval"])
            if isinstance(_cfg.get("llm_tps_cap"), (int, float)) and _cfg["llm_tps_cap"] > 0:
                globals()["LLM_TPS_CAP"] = float(_cfg["llm_tps_cap"])
        print("已加载配置文件: %s" % _CFG_PATH)
    except Exception as _e:
        print("配置文件 %s 解析失败(%s),使用默认配置" % (_CFG_PATH, _e))

# 快慢多线程共享的"当前快照"：快循环每拍刷新 ts 并 append 历史，
# 慢循环整块替换 gpu / system 等键，浅拷贝安全
_history = deque(maxlen=MAX_HISTORY)
_history_lock = threading.Lock()
_csv_init = {"done": False}
_last_csv_t = {"t": 0.0}
_snap_lock = threading.Lock()
_current = {
    "ts": "", "t": 0.0,
    "host": {"hostname": HOSTNAME, "ip": "", "uptime_s": 0},
    "gpu": {"available": False, "gpus": [], "error": None},
    "llama": {"available": False, "online": False, "url": LLM_URL, "error": None,
              "kind": "unknown", "model": None, "probe": {},
              "slots": [], "busy": 0, "total": 0},
    "system": {"cpu_percent": 0.0, "cores": [], "core_count": 0, "load": [0, 0, 0],
               "mem_used": 0, "mem_total": 0, "swap_used": 0, "swap_total": 0,
               "net_rx_bps": 0, "net_tx_bps": 0, "rx_total": 0, "tx_total": 0,
               "uptime_s": 0, "disks": [], "temps": None, "top_procs": []},
}
_busy_s = [0.0]        # 本统计窗口内推理忙碌累计秒（fast 循环累加，stats 线程取走清零）
_gpu_active_s = [0.0]  # 本统计窗口内 GPU 活跃累计秒 util>10%（gpu 循环累加）
_stats_lock = threading.Lock()
_stats_cache = {"ready": False}
_stats_prev_t = [None]
_sys_slow = {"disks": [], "temps": None, "top_procs": [], "ip": ""}

INFERENCE_AVAILABLE = True   # main() 里启动探测后修正
LLM_OK = False
LLM_KIND = "unknown"         # llamacpp | vllm | fastllm | openai | none
LLM_ENGINE_CMD = None        # 引擎进程启动参数串（/proc 扫描,Linux only）
GPU_OK = shutil.which("nvidia-smi") is not None


def _n(v):
    """容错转 float，失败返回 None"""
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _classify_engine(models, metrics=""):
    """Use the backend's own identity; OpenAI is a protocol, not an engine."""
    if isinstance(models, dict):
        for item in models.get("data") or []:
            owner = str(item.get("owned_by") or "").lower() if isinstance(item, dict) else ""
            if "vllm" in owner:
                return "vllm"
            if "fastllm" in owner or "ftllm" in owner:
                return "fastllm"
            if "llama.cpp" in owner or "llamacpp" in owner:
                return "llamacpp"
    if "vllm:" in metrics:
        return "vllm"
    return "openai"


def _prometheus_values(raw, name):
    """Read samples of one exact Prometheus metric, ignoring HELP/TYPE lines."""
    out = []
    for line in raw.splitlines():
        head, _, value = line.partition(" ")
        if (head == name or head.startswith(name + "{")) and value:
            try:
                out.append(float(value.strip()))
            except ValueError:
                pass
    return out


# ---------------- 采样器 adapter ----------------
# GPU 采样和 LLM 采样各收拢成一个类，主循环只调 sample() 接口。
# 以后要支持 AMD/Intel GPU 或 Ollama/vLLM，加新 adapter 类即可，主逻辑不动。

class NvidiaGpuSampler:
    """nvidia-smi 采样（NVIDIA 专用），支持多卡。
    sample() → {"gpus": [...], "error": None|msg}"""

    QUERY = ["nvidia-smi",
             "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,"
             "temperature.gpu,power.draw,fan.speed,uuid",
             "--format=csv,noheader,nounits"]

    QUERY_PROCS = ["nvidia-smi",
                   "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
                   "--format=csv,noheader,nounits"]

    def sample(self):
        try:
            # py3.6 没有 capture_output/text，用 PIPE + universal_newlines；
            # Windows 无窗口运行（pythonw）时必须 CREATE_NO_WINDOW，否则每次
            # 采样都会闪出一个黑色控制台窗口
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            out = subprocess.run(self.QUERY, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, universal_newlines=True,
                                 timeout=5, creationflags=flags).stdout
        except Exception as e:
            return {"available": False, "gpus": [], "processes": [], "error": str(e)}
        gpus = []
        for line in out.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            f = [x.strip() for x in line.split(",")]
            if len(f) < 7:
                continue
            gpus.append({
                "index": int(_n(f[0]) or 0),
                "name": f[1],
                "util": _n(f[2]),
                "mem_used": _n(f[3]),
                "mem_total": _n(f[4]),
                "temp": _n(f[5]),
                "power": _n(f[6]),
                "fan": _n(f[7]) if len(f) > 7 else None,
                "uuid": f[8] if len(f) > 8 else None,
            })
        if not gpus:
            return {"available": False, "gpus": [], "processes": [], "error": "no output"}
        uuid_map = {g["uuid"]: g["index"] for g in gpus if g.get("uuid")}
        return {"available": True, "gpus": gpus,
                "processes": self._query_procs(uuid_map), "error": None}

    def _query_procs(self, uuid_map):
        """占用显存的计算进程（按显存降序，跨卡同 PID 合并并记录所在卡号，最多 12 条）"""
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            out = subprocess.run(self.QUERY_PROCS, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, universal_newlines=True,
                                 timeout=5, creationflags=flags).stdout
        except Exception:
            return []
        agg = {}
        for line in out.strip().splitlines():
            f = [x.strip() for x in line.split(",")]
            if len(f) < 4:
                continue
            uuid, pid, name, mem = f[0], f[1], f[2], (_n(f[3]) or 0)
            if pid not in agg:
                agg[pid] = {"pid": pid, "name": name, "mem": 0, "gpu_idx": set()}
            agg[pid]["mem"] += mem
            gi = uuid_map.get(uuid)
            if gi is not None:
                agg[pid]["gpu_idx"].add(gi)
        procs = []
        for p in agg.values():
            idxs = p.pop("gpu_idx")
            p["gpu"] = ",".join(str(i) for i in sorted(idxs)) if idxs else ""
            procs.append(p)
        return sorted(procs, key=lambda p: -(p["mem"] or 0))[:12]


class LlamaCppSampler:
    """llama.cpp server 采样：/slots 差分算速度，/metrics 拉 Prometheus 计数器。
    （Ollama / vLLM 的 adapter 以后加在这里）"""

    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        # _prev[sid]  = 上一次采样的 (n_decoded, n_prompt_processed, task_id, t)
        # _track[sid] = 当前任务 {task, t0, d0, samples:[(t, n_decoded)...]}
        self._prev = {}
        self._track = {}
        self.sess_decoded = 0  # 面板启动以来观察到的生成 token 累计（按任务差分累加）
        # OpenAI 兼容引擎(fastllm)探测状态
        self._model = None
        self._probe = {"tps": None, "rtt_ms": None, "tokens": 0,
                       "at": 0.0, "err": None, "busy": False}
        # The first telemetry frame must never wait on a generated response.
        self._next_probe_t = time.time() + max(0.0, LLM_PROBE_INTERVAL)
        self._context_limit = None
        self._fastllm_dev_unavailable_until = 0.0
        self._vllm_prev = None

    def _get(self, path, timeout=3):
        with urllib.request.urlopen(self.base_url + path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def _get_metrics(self, timeout=2):
        with urllib.request.urlopen(self.base_url + "/metrics", timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")

    def _post_chat(self, max_tokens):
        body = json.dumps({
            "model": self._model or "default",
            # 接龙式提示词 + 48 上限:避免模型提前 EOS 导致测速只含首字延迟
            "messages": [{"role": "user",
                          "content": "Count from 1 to 99: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,"}],
            "max_tokens": max_tokens, "stream": False,
            # 贪心探测:确定性 + MTP 全效,读数即引擎健康度(投机坏了会从~90掉到~33)
            "temperature": 0}).encode("utf-8")
        req = urllib.request.Request(self.base_url + "/v1/chat/completions",
                                     data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=LLM_PROBE_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8", "replace"))

    def _sample_openai(self):
        """fastllm 等 OpenAI 兼容引擎：无 /slots、无全局计数器。
        空闲时周期发 48 token 轻量探测测空载速度;有真实流量在跑时跳过
        (不抢引擎产能、不产出失真速度),保留上次空载值并标记 busy。
        探测 token 是面板自产的,不计入用量统计;真实 token 计数只有请求方
        （或经 new-api 网关）能看到。"""
        base = {"available": True, "online": True, "kind": "openai",
                "url": self.base_url, "model": self._model, "error": None,
                "engine_cmd": LLM_ENGINE_CMD, "slots": [], "busy": 0, "total": 0,
                "tot_avg_tps": None, "tot_prompt_tps": None, "sess_decoded": None}
        now = time.time()
        if LLM_PROBE_INTERVAL > 0 and now >= self._next_probe_t:
            self._next_probe_t = now + LLM_PROBE_INTERVAL
            _px_snap = _LLM_PROXY["stats"].snapshot() \
                if _LLM_PROXY.get("enabled") else None
            if _px_snap and _px_snap["active"]:
                # 有经代理的真实请求在跑:本轮不发测速探测
                self._probe = dict(self._probe, busy=True, err=None)
            else:
                try:
                    t0 = time.time()
                    d = self._post_chat(LLM_PROBE_TOKENS)
                    rtt = time.time() - t0
                    u = d.get("usage") or {}
                    ct = int(u.get("completion_tokens") or 0)
                    # 1 token 提示词,预填充可忽略:速度≈生成 token / 总耗时
                    tps = round((ct - 1) / max(rtt, 1e-3), 1) if ct > 1 else None
                    self._probe = {"tps": tps, "rtt_ms": int(rtt * 1000),
                                   "tokens": ct, "at": round(now, 1), "err": None,
                                   "busy": rtt > 2.0}   # >2s 说明探测在队列里等=引擎忙(直连流量)
                except Exception as e:
                    self._probe = {"tps": None, "rtt_ms": None, "tokens": 0,
                                   "at": round(now, 1), "err": str(e)[:120], "busy": False}
        p = self._probe
        if now - p.get("at", 0) > 600:  # 探测结果 10 分钟有效
            p = {"tps": None, "rtt_ms": None, "tokens": 0,
                 "at": p.get("at", 0), "err": "stale", "busy": False}
        base["probe"] = p
        base["tot_recent_tps"] = p.get("tps") or 0
        # 透明代理的真实流量优先于探测速度
        if _LLM_PROXY.get("enabled"):
            snap = _LLM_PROXY["stats"].snapshot()
            base["proxy"] = dict(enabled=True, port=_LLM_PROXY.get("port"), **snap)
            base["busy"] = 1 if snap["active"] else 0
            if snap["recent_tps"]:
                base["tot_recent_tps"] = snap["recent_tps"]
        else:
            base["proxy"] = {"enabled": False}
        return base

    def _sample_vllm(self):
        base = self._sample_openai()
        base["kind"] = "vllm"
        base["context_limit"] = self._context_limit
        base["running"] = base["waiting"] = base["kv_cache_pct"] = None
        base["telemetry_source"] = "proxy" if base.get("proxy", {}).get("enabled") else "unavailable"
        try:
            raw = self._get_metrics()
            def total(name):
                vals = _prometheus_values(raw, "vllm:" + name)
                return sum(vals) if vals else None
            base["running"] = total("num_requests_running")
            base["waiting"] = total("num_requests_waiting")
            kv = _prometheus_values(raw, "vllm:kv_cache_usage_perc")
            base["kv_cache_pct"] = round(max(kv) * 100, 1) if kv else None
            base["telemetry_source"] = "engine"
            base["busy"] = int(bool(base["running"]))
            base["total"] = base["running"]
            generated = total("generation_tokens_total")
            sampled_at = time.time()
            if generated is not None and self._vllm_prev is not None:
                old_t, old_generated = self._vllm_prev
                if generated >= old_generated and sampled_at > old_t:
                    base["tot_recent_tps"] = round(
                        (generated - old_generated) / (sampled_at - old_t), 1)
            self._vllm_prev = (sampled_at, generated) if generated is not None else None
        except Exception as e:
            base["telemetry_error"] = str(e)[:120]
        return base

    def _sample_fastllm(self):
        base = self._sample_openai()
        base["kind"] = "fastllm"
        base["context_limit"] = self._context_limit
        base["running"] = None
        base["telemetry_source"] = "proxy" if base.get("proxy", {}).get("enabled") else "unavailable"
        if time.time() >= self._fastllm_dev_unavailable_until:
            try:
                data = self._get("/v1/active_conversations", timeout=2)
                base["running"] = data.get("count") if isinstance(data, dict) else None
                base["telemetry_source"] = "engine"
                if base["running"] is not None:
                    base["busy"] = int(base["running"] > 0)
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 404):
                    self._fastllm_dev_unavailable_until = time.time() + 60
            except Exception as e:
                base["telemetry_error"] = str(e)[:120]
        return base

    def metrics(self):
        """拉取 llama-server Prometheus 文本指标，返回 {name: float}"""
        with urllib.request.urlopen(self.base_url + "/metrics", timeout=3) as r:
            text = r.read().decode("utf-8", "replace")
        out = {}
        for line in text.splitlines():
            if not line.startswith("llamacpp:"):
                continue
            name, _, val = line.rpartition(" ")
            try:
                out[name] = float(val)
            except ValueError:
                pass
        return out

    def sample(self):
        """查询 /slots，差分计算每个 slot 的 3s 窗口速度 / 任务平均速度 / prompt 速度"""
        if LLM_KIND == "vllm":
            return self._sample_vllm()
        if LLM_KIND == "fastllm":
            return self._sample_fastllm()
        if LLM_KIND == "openai":
            return self._sample_openai()
        base = {"available": False, "url": self.base_url, "online": False, "error": None,
                "kind": "llamacpp", "model": None, "probe": {},
                "engine_cmd": LLM_ENGINE_CMD,
                "slots": [], "busy": 0, "total": 0}
        try:
            slots_raw = self._get("/slots")
            if not isinstance(slots_raw, list):
                raise ValueError("bad /slots response")
        except Exception as e:
            base["error"] = str(e)
            return base

        now = time.time()
        slots = []
        busy = 0
        for raw in slots_raw:
            if not isinstance(raw, dict):
                continue
            sid = raw.get("id")
            task = raw.get("id_task")
            ctx = raw.get("n_ctx", 0) or 0
            n_prompt = raw.get("n_prompt_tokens", 0) or 0
            n_prompt_proc = raw.get("n_prompt_tokens_processed", 0) or 0
            nt = (raw.get("next_token") or [{}])[0]
            if not isinstance(nt, dict):
                nt = {}
            n_decoded = nt.get("n_decoded", 0) or 0
            n_remain = nt.get("n_remain")
            processing = bool(raw.get("is_processing"))
            if processing:
                busy += 1

            # --- 记录上次采样 + 观察生成 token 累计 ---
            prev = self._prev.get(sid)
            if prev and task == prev.get("task"):
                d_dec = n_decoded - prev.get("n_decoded", 0)
                if d_dec > 0:
                    self.sess_decoded += d_dec
            self._prev[sid] = {"t": now, "n_decoded": n_decoded,
                               "n_prompt_processed": n_prompt_proc, "task": task}

            # --- 任务追踪：任务切换（task id 变化）时重置 ---
            tr = self._track.get(sid)
            if tr is None or tr.get("task") != task:
                tr = {"task": task, "t0": now, "d0": n_decoded, "p0": n_prompt_proc,
                      "samples": deque(maxlen=64), "psamples": deque(maxlen=64)}
                self._track[sid] = tr
            tr["samples"].append((now, n_decoded))
            tr["psamples"].append((now, n_prompt_proc))
            cutoff = now - RECENT_KEEP_S
            while tr["samples"] and tr["samples"][0][0] < cutoff:
                tr["samples"].popleft()
            while tr["psamples"] and tr["psamples"][0][0] < cutoff:
                tr["psamples"].popleft()
            task_elapsed = round(now - tr["t0"], 1) if processing else None

            # --- Prompt (prefill) 速度：10s 滑动窗口 ---
            # n_prompt_tokens_processed 按 batch 跳变（chunked prefill），相邻差分
            # 会在 0 和 batch 速率之间横跳；10s 窗口跨多个 batch，毛刺被抹平。
            prompt_tps = None
            if processing and n_decoded == 0 and tr["psamples"]:
                ref_t, ref_p = tr["psamples"][0]
                d_pp = n_prompt_proc - ref_p
                if d_pp > 0 and now > ref_t:
                    prompt_tps = round(d_pp / (now - ref_t), 1)

            gen_recent = gen_avg = None
            if processing and n_decoded > 0:
                # 任务平均速度：从本任务第一个 token 落地起算，不含预填充耗时
                if tr.get("g0_t") is None or n_decoded < tr.get("g0_d", 0):
                    tr["g0_t"], tr["g0_d"] = now, n_decoded
                dt_avg = max(now - tr["g0_t"], 1e-6)
                d_avg = n_decoded - tr["g0_d"]
                if d_avg > 0:
                    gen_avg = round(d_avg / dt_avg, 1)
                # 3s 窗口速度：找最接近 now-3s 的样本做基准
                target = now - RECENT_WINDOW_S
                ref_t, ref_d = tr["t0"], tr["d0"]
                for (st, sd) in tr["samples"]:
                    if st <= target:
                        ref_t, ref_d = st, sd
                    else:
                        break
                dt_r = max(now - ref_t, 1e-6)
                d_r = n_decoded - ref_d
                if d_r > 0:
                    gen_recent = round(d_r / dt_r, 1)

            remain_est = None
            if processing and n_remain and n_remain > 0:
                sp = gen_recent if gen_recent else gen_avg
                if sp:
                    remain_est = round(n_remain / sp, 1)

            slots.append({
                "id": sid,
                "processing": processing,
                "task": task,
                "ctx": ctx,
                "ctx_used": n_prompt,
                "ctx_pct": round(n_prompt / ctx * 100, 1) if ctx else 0,
                "n_decoded": n_decoded,
                "gen_recent_tps": gen_recent,
                "gen_avg_tps": gen_avg,
                "prompt_tps": prompt_tps,
                "task_elapsed": task_elapsed,
                "remain_est": remain_est,
                "has_next": nt.get("has_next_token"),
                "n_remain": n_remain,
                "speculative": raw.get("speculative"),
            })

        base.update({"available": True, "online": True, "slots": slots,
                     "busy": busy, "total": len(slots),
                     "tot_recent_tps": round(sum(sl["gen_recent_tps"] or 0 for sl in slots), 1),
                     "tot_avg_tps": round(sum(sl["gen_avg_tps"] or 0 for sl in slots), 1),
                     "tot_prompt_tps": round(sum(sl["prompt_tps"] or 0 for sl in slots), 1),
                     "sess_decoded": self.sess_decoded})
        return base


GPU_SAMPLER = NvidiaGpuSampler()
LLM_SAMPLER = LlamaCppSampler(LLM_URL)


def _detect_engine():
    """探测 LLM_URL 上的推理引擎类型。
    /slots 200 = llama.cpp;否则 /v1/models 有响应 = OpenAI 兼容(fastllm 等)。
    返回 (reachable, kind, model|None)。HTTP 4xx 也算可达——服务有响应。"""
    base = LLM_URL.rstrip("/")
    LLM_SAMPLER._context_limit = None
    reachable = False
    try:
        with urllib.request.urlopen(base + "/slots", timeout=3) as r:
            if r.status == 200:
                return True, "llamacpp", None
        reachable = True
    except urllib.error.HTTPError:
        reachable = True
    except Exception:
        pass
    model = None
    try:
        with urllib.request.urlopen(base + "/v1/models", timeout=3) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        reachable = True
        items = data.get("data") if isinstance(data, dict) else None
        if not items and isinstance(data, dict):
            items = data.get("models")
        for m in items or []:
            if isinstance(m, dict) and m.get("id"):
                model = str(m["id"])
                for key in ("max_model_len", "context_window", "max_context_window"):
                    val = m.get(key)
                    if isinstance(val, (int, float)) and val > 0:
                        LLM_SAMPLER._context_limit = int(val)
                        break
                break
            if isinstance(m, str):
                model = m
                break
        kind = _classify_engine(data)
        if kind == "openai":
            try:
                with urllib.request.urlopen(base + "/metrics", timeout=1) as r:
                    kind = _classify_engine(data, r.read(65536).decode("utf-8", "replace"))
            except Exception:
                pass
        return True, kind, model
    except urllib.error.HTTPError:
        return True, "openai", None
    except Exception:
        pass
    return reachable, ("openai" if reachable else "none"), None


def read_engine_cmd(engine_port=None):
    """扫描 /proc 找推理引擎进程(ftllm server/llama-server),返回其启动参数串。
    面板与引擎同用户时 /proc/<pid>/cmdline 可读;Windows 无 /proc 返回 None。
    按 argv 结构识别而非字符串包含——bash/ssh 里带引擎命令文本的包装进程
    会骗过包含匹配(2026-09-24 实踩两次:ftllm launch 面板进程、agent 的启停命令)。
    engine_port: 引擎监听端口,给了就要求 --port 对得上。"""
    _MAINS = ("ftllm", "ftllm.cli", "llama-server")
    try:
        for pid in sorted(os.listdir("/proc"), key=lambda s: int(s) if s.isdigit() else 0):
            if not pid.isdigit():
                continue
            try:
                with open("/proc/%s/cmdline" % pid, "rb") as f:
                    raw = f.read()
            except Exception:
                continue
            if not raw:
                continue
            toks = [t.decode("utf-8", "replace") for t in raw.split(b"\x00") if t]
            if not toks:
                continue
            # 只认 python/ftllm/llama-server 直接启动的进程,bash -c/ssh/sudo 包装全排除
            if os.path.basename(toks[0]).lower() not in ("python3", "python", "ftllm"):
                continue
            main = None
            for i, t in enumerate(toks[:3]):
                b = os.path.basename(t).lower()
                if b in _MAINS:
                    main = (i, b)
                    break
            if main is None:
                continue
            mi, mb = main
            if "llama-server" not in mb and toks[mi + 1:mi + 2] != ["server"]:
                continue                      # ftllm 必须紧跟 server 子命令(launch/serve 不算)
            cmd = " ".join(toks)
            if engine_port and ("--port %d" % engine_port) not in cmd and \
                    ("--port=%d" % engine_port) not in cmd:
                continue
            return cmd[:300]
    except Exception:
        pass
    return None


def _probe_llama():
    """探测推理引擎是否可达,并维护引擎类型与模型名"""
    global LLM_KIND, LLM_ENGINE_CMD
    ok, kind, model = _detect_engine()
    if ok:
        if kind != LLM_KIND:
            LLM_SAMPLER._vllm_prev = None
        LLM_KIND = kind
        if kind in ("vllm", "fastllm", "openai") and model:
            LLM_SAMPLER._model = model
    if os.path.isdir("/proc"):
        _port = None
        try:
            _port = urllib.parse.urlparse(LLM_SAMPLER.base_url).port
        except Exception:
            pass
        LLM_ENGINE_CMD = read_engine_cmd(_port)
    return ok


# ---------------- LLM 透明代理（记录真实用量） ----------------
# fastllm 等引擎不暴露任何计数器,唯一能拿到真实 token 的办法就是让流量经过面板。
# 代理把请求原样转发给引擎,同时从响应(SSE 流或 JSON)里抓 usage 记账。

class _LiveStream(object):
    """单个在飞请求的流式活账:字符累计 + 独立估算速率(EMA)"""
    __slots__ = ("t0", "chars", "last_t", "last_chars", "ema",
                 "request_id", "endpoint", "model", "max_tokens")

    def __init__(self, now):
        self.t0 = now
        self.chars = 0
        self.last_t = now
        self.last_chars = 0
        self.ema = None
        self.request_id = "%06x" % (id(self) & 0xffffff)
        self.endpoint = ""
        self.model = None
        self.max_tokens = None


class _ProxyStats:
    """代理流量账本（面板生命周期内的累计;进程重启清零,明细另有 jsonl 落盘）"""

    def __init__(self):
        self.lock = threading.Lock()
        self.sess_p = 0        # 累计 prompt token
        self.sess_c = 0        # 累计 completion token
        self.sess_cache = 0    # 累计缓存命中 token
        self.sess_rtt = 0.0    # 累计请求耗时秒(算真实平均速度用)
        self.reqs = 0
        self.errs = 0
        self.in_flight = 0
        self.last_end_t = 0.0
        self.recent = deque(maxlen=64)   # 最近请求明细（新到旧展示用）
        self.tps_win = deque(maxlen=256)  # (end_t, ct) 供 10s 窗口速度
        self.live = {}                    # 在飞请求的流式活账句柄(id->_LiveStream)
        self.cpt = 2.5                    # chars/token 比率,完成请求用精确 usage 校准

    def begin(self):
        now = time.time()
        h = _LiveStream(now)
        with self.lock:
            self.in_flight += 1
            self.live[id(h)] = h
        return h

    def describe(self, h, path, body):
        """Keep only non-content metadata; token usage comes from the response."""
        if h is None:
            return
        h.endpoint = path.split("?", 1)[0]
        if not body or len(body) > 1024 * 1024:
            return
        try:
            data = json.loads(body.decode("utf-8"))
            if isinstance(data, dict):
                h.model = str(data["model"])[:80] if data.get("model") else None
                maximum = data.get("max_tokens", data.get("max_output_tokens"))
                h.max_tokens = int(maximum) if maximum is not None else None
        except (ValueError, UnicodeDecodeError, TypeError):
            pass

    def stream(self, h, n_chars):
        """流式转发时按字符增量更新该请求的独立估算速率(EMA 平滑)"""
        if h is None or n_chars <= 0:
            return
        now = time.time()
        h.chars += n_chars
        dt = now - h.last_t
        if dt < 0.4:
            return
        with self.lock:
            cpt = self.cpt
        rate = (h.chars - h.last_chars) / cpt / dt
        h.ema = rate if h.ema is None else h.ema * 0.5 + rate * 0.5
        h.last_t = now
        h.last_chars = h.chars

    def finish(self, pt, ct, cache, rtt=None, stream=False, err=False, h=None):
        now = time.time()
        with self.lock:
            self.in_flight = max(0, self.in_flight - 1)
            chars = 0
            if h is not None:
                self.live.pop(id(h), None)
                chars = h.chars
            if err:
                self.errs += 1
                return
            if not pt and not ct:
                return  # 非推理请求(如 /v1/models 探测)不入账
            # 用精确 usage 校准字符/token 比率(流式活账的折算依据)
            if ct and chars:
                ratio = chars / float(ct)
                if 0.5 <= ratio <= 20.0:
                    self.cpt = min(8.0, max(0.8, self.cpt * 0.8 + ratio * 0.2))
            self.reqs += 1
            self.sess_p += int(pt or 0)
            self.sess_c += int(ct or 0)
            self.sess_cache += int(cache or 0)
            self.sess_rtt += float(rtt or 0)
            if ct:
                self.tps_win.append((now, int(ct), float(rtt or 0)))
            self.last_end_t = now
            self.recent.append({"t": now, "pt": int(pt or 0), "ct": int(ct or 0),
                                "cache": int(cache or 0),
                                "rtt": round(rtt, 2) if rtt else None,
                                "stream": bool(stream)})
        _append_request_log(now, pt, ct, cache, rtt, stream)

    def recent_tps(self, window=10.0):
        now = time.time()
        with self.lock:
            vals = [c for (t, c, _rt) in self.tps_win if now - t <= window]
        return round(sum(vals) / window, 1) if vals else None

    def is_busy(self):
        now = time.time()
        with self.lock:
            return self.in_flight > 0 or (now - self.last_end_t) < 5.0

    def snapshot(self):
        now = time.time()
        with self.lock:
            s_p, s_c, s_cache = self.sess_p, self.sess_c, self.sess_cache
            s_rtt = self.sess_rtt
            reqs, errs, in_flight = self.reqs, self.errs, self.in_flight
            last = self.last_end_t
            win = list(self.tps_win)
            recent = list(self.recent)[-8:][::-1]  # 新到旧,最多 8 条
            live = list(self.live.values())
            cpt = self.cpt
        tps = []
        for (t, c, rt) in win:
            # 完成请求的 token 按其真实耗时摊回窗口(重叠比例计账),
            # 消除"长请求完成瞬间整单入库"造成的算法性尖峰
            span = max(rt, 0.5)
            overlap = min(t, now) - max(t - span, now - 10.0)
            if overlap > 0:
                tps.append(c * overlap / span)
        streams = []
        active_requests = []
        for h in live:
            active_requests.append({"id": h.request_id, "endpoint": h.endpoint,
                                    "model": h.model, "max_tokens": h.max_tokens,
                                    "output_est": round(h.chars / cpt) if h.chars else None,
                                    "secs": round(now - h.t0, 1)})
            if h.chars > 0 and h.ema is not None:
                streams.append({"tps": round(h.ema, 1),
                                "secs": round(now - h.t0, 1)})
        streams.sort(key=lambda s: -s["tps"])
        if streams:
            # 有在飞流:总速=分路之和(≈),避免刚完成请求的 10s 精确尾巴压过现场
            r_tps, est = round(sum(s["tps"] for s in streams), 1), True
        elif tps:
            r_tps, est = round(sum(tps) / 10.0, 1), False
        else:
            r_tps, est = None, False
        return {"reqs": reqs, "errs": errs, "in_flight": in_flight,
                "sess_p": s_p, "sess_c": s_c, "sess_cache": s_cache,
                "sess_rtt": round(s_rtt, 1),
                "recent_tps": r_tps, "recent_est": est, "streams": streams,
                 "active_requests": active_requests,
                "active": in_flight > 0 or (now - last) < 5.0,
                "recent": recent}


_PROXY_ERR_DUMP = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "proxy_last_error.json")
_LLM_PROXY = {"enabled": False, "port": 0, "stats": _ProxyStats()}


def _append_request_log(t, pt, ct, cache, rtt, stream):
    """逐请求明细落盘(只记 token 数/耗时,不记内容);超 5MB 轮转 _old"""
    try:
        if os.path.exists(REQUESTS_LOG) and os.path.getsize(REQUESTS_LOG) > REQUESTS_MAX_BYTES:
            try:
                os.replace(REQUESTS_LOG, REQUESTS_LOG[:-6] + "_old.jsonl")
            except OSError:
                pass
        with open(REQUESTS_LOG, "a") as f:
            f.write(json.dumps({
                "t": round(t, 2),
                "ts": datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S"),
                "pt": int(pt or 0), "ct": int(ct or 0), "cache": int(cache or 0),
                "rtt": round(rtt, 3) if rtt else None, "stream": bool(stream),
            }, ensure_ascii=False) + "\n")
    except Exception:
        pass


class _ProxyHandler(BaseHTTPRequestHandler):
    """把 /v1/* 原样转发给推理引擎,流式透传响应并抓 usage 记账"""

    def log_message(self, fmt, *args):
        pass  # 静默访问日志

    def _forward(self):
        stats = _LLM_PROXY["stats"]
        h = stats.begin()
        pt = ct = cache = 0
        stream = False
        rtt = None
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req_body = body = self.rfile.read(n) if n else None
            stats.describe(h, self.path, req_body)
            headers = {"Content-Type": self.headers.get("Content-Type",
                                                       "application/json")}
            auth = self.headers.get("Authorization")
            if auth:
                headers["Authorization"] = auth
            req = urllib.request.Request(LLM_URL + self.path, data=body,
                                         headers=headers, method=self.command)
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=LLM_PROXY_TIMEOUT) as up:
                ctype = up.headers.get("Content-Type", "application/json")
                stream = "text/event-stream" in (ctype or "")
                self.send_response(up.status)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                raw = b""
                linebuf = b""
                while True:
                    # read(1024) waits for the whole buffer on SSE; read1 returns
                    # available bytes so a short token event reaches the client now.
                    chunk = up.read1(1024) if stream else up.read(1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    try:
                        self.wfile.flush()
                    except Exception:
                        pass
                    if len(raw) < 16 * 1024 * 1024:  # 抓 usage 用,封顶 16MB
                        raw += chunk
                    if stream:
                        # 流式活账:数完整 SSE 行里的 delta 字符(按请求独立估算速率)
                        linebuf += chunk
                        *lines, linebuf = linebuf.split(b"\n")
                        n_chars = 0
                        for ln in lines:
                            ln = ln.strip()
                            if not ln.startswith(b"data:"):
                                continue
                            payload = ln[5:].strip()
                            if not payload or payload == b"[DONE]":
                                continue
                            try:
                                d = json.loads(payload.decode("utf-8", "replace"))
                            except ValueError:
                                continue
                            try:
                                dl = d["choices"][0].get("delta") or {}
                            except (KeyError, IndexError, AttributeError, TypeError):
                                continue
                            for k in ("content", "reasoning_content"):
                                v = dl.get(k)
                                if isinstance(v, str):
                                    n_chars += len(v)
                        if n_chars:
                            stats.stream(h, n_chars)
            rtt = time.time() - t0
            usage = _extract_usage(raw, ctype)
            if usage:
                pt = int(usage.get("prompt_tokens") or 0)
                ct = int(usage.get("completion_tokens") or 0)
                det = usage.get("prompt_tokens_details") or {}
                cache = int(det.get("cached_tokens") or 0)
            stats.finish(pt, ct, cache, rtt=rtt, stream=stream, h=h)
        except urllib.error.HTTPError as e:
            # 引擎 4xx/5xx:透传真实状态码与错误体(此前包成 502 丢失关键信息),
            # 并把触发失败的请求体落盘供排查(只留最近一次)
            try:
                err_body = e.read()
                try:
                    if req_body:
                        with open(_PROXY_ERR_DUMP, "wb") as f:
                            f.write(req_body)
                        with open(_PROXY_ERR_DUMP + ".resp", "wb") as f:
                            f.write(("HTTP %d\n" % e.code).encode() + err_body)
                except Exception:
                    pass
                self.send_response(e.code)
                self.send_header("Content-Type",
                                 e.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(err_body)))
                self.end_headers()
                self.wfile.write(err_body)
            except Exception:
                pass
            stats.finish(0, 0, 0, err=True, h=h)
        except Exception as e:
            try:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                msg = json.dumps({"error": "proxy: %s" % e}).encode()
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
            except Exception:
                pass
            stats.finish(0, 0, 0, err=True, h=h)

    do_GET = _forward
    do_POST = _forward


def _extract_usage(raw, ctype):
    """从响应字节里抓 usage:SSE 逐行找 data:{...usage},JSON 直接解析。
    fastllm/llama.cpp 的流式 usage 都在最后一个带 usage 的 chunk 里(后到覆盖)"""
    if not raw:
        return None
    usage = None
    for line in raw.split(b"\n"):
        line = line.strip()
        if not line.startswith(b"data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == b"[DONE]":
            continue
        try:
            d = json.loads(payload.decode("utf-8", "replace"))
        except ValueError:
            continue
        if isinstance(d, dict) and isinstance(d.get("usage"), dict):
            usage = d["usage"]
    if usage:
        return usage
    if "json" in (ctype or ""):
        try:
            d = json.loads(raw.decode("utf-8", "replace"))
            if isinstance(d, dict) and isinstance(d.get("usage"), dict):
                return d["usage"]
        except ValueError:
            pass
    return None


def start_llm_proxy():
    """启动 LLM 透明代理;端口被占(引擎还没挪走)时每 15s 重试,迁走后自动接管。
    上游端口与代理端口相同会自环,拒绝启动。"""
    if LLM_PROXY_PORT <= 0:
        return
    try:
        up_port = urlparse(LLM_URL).port
    except Exception:
        up_port = None
    if up_port == LLM_PROXY_PORT:
        print("LLM 代理端口与上游端口相同(%d,会自环)——代理未启动" % LLM_PROXY_PORT)
        return

    def _serve():
        while True:
            try:
                srv = ThreadingHTTPServer((LLM_PROXY_HOST, LLM_PROXY_PORT),
                                          _ProxyHandler)
                srv.daemon_threads = True
                _LLM_PROXY["enabled"] = True
                _LLM_PROXY["port"] = LLM_PROXY_PORT
                print("LLM 透明代理已启动: http://%s:%d → %s"
                      % (LLM_PROXY_HOST, LLM_PROXY_PORT, LLM_URL))
                print("  所有客户端照常访问原端口即可,流量自动记账")
                srv.serve_forever()
                return
            except OSError:
                if not _LLM_PROXY.get("retrying"):
                    print("端口 %d 暂被占用,每 15s 重试(引擎迁走后自动接管)"
                          % LLM_PROXY_PORT)
                    _LLM_PROXY["retrying"] = True
                time.sleep(15)
            except Exception as e:
                print("LLM 代理异常退出(%s),15s 后重试" % e)
                time.sleep(15)

    threading.Thread(target=_serve, daemon=True).start()


# ---------------- 系统采样（融合 node01_panel，纯 /proc + /sys） ----------------

def read_cpu_stat():
    """每核 /proc/stat → [(total, idle), ...]；读不到返回 []"""
    per = []
    try:
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("cpu") and len(line) > 3 and line[3].isdigit():
                    p = line.split()
                    vals = list(map(int, p[1:]))
                    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
                    per.append((sum(vals), idle))
    except Exception:
        pass
    return per


def cpu_pcts(prev, cur):
    """两次采样差分 → 每核占用 %"""
    out = []
    try:
        for (tb, ib), (tc, ic) in zip(prev, cur):
            dt, di = tc - tb, ic - ib
            out.append(round(100.0 * (dt - di) / dt, 1) if dt > 0 else 0.0)
    except Exception:
        pass
    return out


def read_mem():
    """读 /proc/meminfo → {"mem_total","mem_used","swap_total","swap_used"}（kB）"""
    d = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                try:
                    k, v = line.split(":", 1)
                    d[k] = int(v.split()[0])  # kB
                except (ValueError, IndexError):
                    continue
    except Exception:
        pass
    total = d.get("MemTotal", 0)
    avail = d.get("MemAvailable", d.get("MemFree", 0))
    sw_t = d.get("SwapTotal", 0)
    sw_f = d.get("SwapFree", 0)
    return {"mem_total": total, "mem_used": total - avail,
            "swap_total": sw_t, "swap_used": sw_t - sw_f}


def read_net():
    """所有非 lo 网卡的累计收发字节数 → (rx, tx)；Windows 走 psutil"""
    rx = tx = 0
    try:
        with open("/proc/net/dev") as f:
            for line in f:
                if ":" not in line:
                    continue
                dev, rest = line.split(":", 1)
                if dev.strip() == "lo":
                    continue
                p = rest.split()
                if len(p) >= 9:
                    rx += int(p[0])
                    tx += int(p[8])
    except Exception:
        pass
    if rx == 0 and tx == 0 and psutil is not None:
        try:
            c = psutil.net_io_counters()
            rx, tx = c.bytes_recv, c.bytes_sent
        except Exception:
            pass
    return rx, tx


_REAL_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs",
            "ntfs", "ntfs3", "vfat", "exfat", "fuseblk"}


def read_disks():
    """读 /proc/mounts + statvfs → [{mount,total,used,avail,used_pct}]（字节）"""
    out = []
    seen = set()
    try:
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                mnt, fstype = parts[1], parts[2]
                if fstype not in _REAL_FS or mnt in seen:
                    continue
                try:
                    st = os.statvfs(mnt)
                except OSError:
                    continue
                total = st.f_blocks * st.f_frsize
                if total <= 0:
                    continue
                seen.add(mnt)
                used = total - st.f_bfree * st.f_frsize
                avail = st.f_bavail * st.f_frsize
                out.append({"mount": mnt, "total": total, "used": used,
                            "avail": avail, "used_pct": round(100.0 * used / total, 1)})
    except Exception:
        pass
    if not out and psutil is not None:  # Windows：/proc/mounts 与 statvfs 都不存在
        try:
            for pt in psutil.disk_partitions(all=False):
                if "cdrom" in pt.opts or not pt.fstype:
                    continue
                try:
                    u = psutil.disk_usage(pt.mountpoint)
                except Exception:
                    continue
                if u.total <= 0:
                    continue
                out.append({"mount": pt.mountpoint, "total": u.total,
                            "used": u.used, "avail": u.free,
                            "used_pct": round(100.0 * u.used / u.total, 1)})
        except Exception:
            pass
    out.sort(key=lambda d2: (d2["mount"] != "/", d2["mount"]))  # 根分区排最前
    return out


def read_temps():
    """CPU 相关温度（/sys/class/hwmon，node01 有 coretemp；取不到返回 None）"""
    temps = []
    base = "/sys/class/hwmon"
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return None
    for hw in names:
        try:
            with open(os.path.join(base, hw, "name")) as f:
                name = f.read().strip().lower()
        except OSError:
            continue
        ok = name in ("coretemp", "acpitz", "k10temp", "zenpower", "cpu_thermal") \
            or ("cpu" in name)
        bad = ("gpu" in name or "nvme" in name or "nouveau" in name
               or "amdgpu" in name or "drivetemp" in name)
        if not ok or bad:
            continue
        try:
            files = sorted(os.listdir(os.path.join(base, hw)))
        except OSError:
            continue
        for f in files:
            if not (f.startswith("temp") and f.endswith("_input")):
                continue
            try:
                with open(os.path.join(base, hw, f)) as fh:
                    v = int(fh.read().strip()) / 1000.0
            except (OSError, ValueError):
                continue
            lab = name
            try:
                with open(os.path.join(base, hw, f.replace("_input", "_label"))) as fh:
                    lab = fh.read().strip()
            except OSError:
                pass
            # 语义化中文标签："Package id 0"→"CPU 0"，"Core 8"→"核心 8"
            lab = lab.replace("Package id ", "CPU ").replace("Core ", "核心 ")
            temps.append({"label": lab, "temp": round(v, 1)})
    return temps or None


def read_top():
    """TOP 进程 → [{pid,name,cpu,mem,rss_mb}]，按 CPU 排序。
    Linux 用 ps -eo；Windows 没有 ps，且控制台程序会闪黑框，直接走 psutil"""
    if os.name == "nt" and psutil is not None:
        try:
            procs = []
            for pr in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "memory_info"]):
                try:
                    inf = pr.info
                    nm = (inf.get("name") or "?")
                    if nm == "System Idle Process":
                        continue  # Windows 空闲进程的 cpu 值=全核空闲率总和，纯属噪音
                    rss = inf.get("memory_info")
                    procs.append({"pid": inf["pid"], "name": nm[:24],
                                  "cpu": inf.get("cpu_percent") or 0.0,
                                  "mem": inf.get("memory_percent") or 0.0,
                                  "rss_mb": round((rss.rss if rss else 0) / 1048576.0, 1)})
                except Exception:
                    continue
            procs.sort(key=lambda x: -x["cpu"])
            return procs[:10]
        except Exception:
            pass
    try:
        r = subprocess.run(["ps", "-eo", "pid,comm,pcpu,pmem,rss", "--sort=-pcpu"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=5)
        rows = []
        for line in r.stdout.splitlines()[1:]:
            p = line.split(None, 5)
            if len(p) >= 5 and p[0].isdigit():
                try:
                    rows.append({"pid": int(p[0]), "name": p[1],
                                 "cpu": float(p[2]), "mem": float(p[3]),
                                 "rss_mb": round(int(p[4]) / 1024.0, 1)})
                except ValueError:
                    continue
            if len(rows) >= 10:
                break
        if rows or psutil is None:
            return rows
    except Exception:
        pass
    if psutil is not None:  # ps 失败的兜底
        try:
            procs = []
            for pr in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "memory_info"]):
                try:
                    inf = pr.info
                    nm = (inf.get("name") or "?")
                    if nm == "System Idle Process":
                        continue  # Windows 空闲进程的 cpu 值=全核空闲率总和，纯属噪音
                    rss = inf.get("memory_info")
                    procs.append({"pid": inf["pid"], "name": nm[:24],
                                  "cpu": inf.get("cpu_percent") or 0.0,
                                  "mem": inf.get("memory_percent") or 0.0,
                                  "rss_mb": round((rss.rss if rss else 0) / 1048576.0, 1)})
                except Exception:
                    continue
            procs.sort(key=lambda x: -x["cpu"])
            return procs[:10]
        except Exception:
            pass
    return []


def read_uptime():
    """系统运行时长秒（/proc/uptime；Windows 走 psutil.boot_time）"""
    try:
        with open("/proc/uptime") as f:
            return round(float(f.read().split()[0]))
    except Exception:
        pass
    if psutil is not None:
        try:
            return round(time.time() - psutil.boot_time())
        except Exception:
            pass
    return 0


def read_load():
    try:
        l = os.getloadavg()
        return [round(l[0], 2), round(l[1], 2), round(l[2], 2)]
    except Exception:
        return [0, 0, 0]


def read_phys_cores():
    """物理核数：/proc/cpuinfo 唯一 (physical id, core id) 组合；Windows 走 psutil。取不到返回 0"""
    pairs = set()
    pid = cid = None
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                k = k.strip()
                if k == "physical id":
                    pid = v.strip()
                elif k == "core id":
                    cid = v.strip()
                elif k.startswith("processor"):
                    if pid is not None and cid is not None:
                        pairs.add((pid, cid))
                    pid = cid = None
        if pid is not None and cid is not None:
            pairs.add((pid, cid))
    except Exception:
        pass
    if pairs:
        return len(pairs)
    if psutil is not None:
        try:
            n = psutil.cpu_count(logical=False)
            if n:
                return n
        except Exception:
            pass
    return 0


def get_ip():
    """默认路由出口 IP（UDP connect，不发包）"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("223.5.5.5", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return ""


# ---------------- CSV 日志（可选，CSV_INTERVAL<=0 关闭） ----------------

def _write_csv(s):
    sy = s.get("system") or {}
    gpus = (s.get("gpu") or {}).get("gpus") or []
    # 多卡聚合：利用率取均值、温度取峰值（2026-09-23 双卡化）
    utils = [g.get("util") for g in gpus if g.get("util") is not None]
    temps = [g.get("temp") for g in gpus if g.get("temp") is not None]
    g_util = round(sum(utils) / len(utils), 1) if utils else ""
    g_temp = max(temps) if temps else ""
    L = s.get("llama") or {}
    slots = L.get("slots", []) or []
    tps = max([sl.get("gen_recent_tps") or 0 for sl in slots] + [0])
    mem_pct = ""
    if sy.get("mem_total"):
        mem_pct = round(100.0 * (sy.get("mem_used") or 0) / sy["mem_total"], 1)
    load = sy.get("load") or [0, 0, 0]
    row = [
        s.get("ts", ""),
        sy.get("cpu_percent", ""), mem_pct, load[0],
        round((sy.get("net_rx_bps") or 0) / 8.0 / 1024.0, 1),  # KB/s
        round((sy.get("net_tx_bps") or 0) / 8.0 / 1024.0, 1),
        g_util, g_temp,
        ("off" if not L.get("online") else "%d/%d" % (L.get("busy", 0), L.get("total", 0))),
        tps,
    ]
    try:
        rotated = False
        if os.path.exists(CSV_LOG) and os.path.getsize(CSV_LOG) > CSV_MAX_BYTES:
            try:
                os.replace(CSV_LOG, CSV_LOG[:-4] + "_old.csv")
                rotated = True
            except OSError:
                pass
        new = rotated or not _csv_init["done"]
        with open(CSV_LOG, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["time", "cpu_pct%", "mem_pct%", "load1",
                            "rx_KBps", "tx_KBps", "gpu_util_avg%", "gpu_temp_max_C",
                            "llama_busy", "llama_gen3s_tps"])
            w.writerow(row)
        _csv_init["done"] = True
    except Exception:
        pass


# ---------------- 采样循环 ----------------

def inference_loop_fast():
    """快循环（默认 2s）：采 llama.cpp /slots（未启用则置 unavailable），刷新 ts 并 append 历史/CSV"""
    while True:
        try:
            if LLM_OK:
                llama = LLM_SAMPLER.sample()
                if llama.get("busy"):
                    _busy_s[0] += SAMPLE_INTERVAL  # 本拍有 slot 在生成 → 计入推理忙碌时长
            else:
                llama = {"available": False, "online": False, "url": LLM_URL,
                         "error": "disabled", "kind": LLM_KIND, "model": None,
                         "probe": {}, "slots": [], "busy": 0, "total": 0}
            now = time.time()
            with _snap_lock:
                _current["llama"] = llama
                _current["ts"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                _current["t"] = now
                s = dict(_current)
            with _history_lock:
                _history.append(s)
            # CSV 按 CSV_INTERVAL 间隔落盘（默认 10s）；<=0 完全关闭
            if CSV_INTERVAL > 0 and now - _last_csv_t["t"] >= CSV_INTERVAL:
                _write_csv(s)
                _last_csv_t["t"] = now
        except Exception:
            time.sleep(1)
        time.sleep(SAMPLE_INTERVAL)


def gpu_loop():
    """GPU 慢循环（默认 10s）：nvidia-smi 每次拉起子进程开销大；无 GPU 静默降级"""
    while True:
        try:
            if GPU_OK:
                gpu = GPU_SAMPLER.sample()
            else:
                gpu = {"available": False, "gpus": [], "error": "nvidia-smi not found"}
            gpus = gpu.get("gpus") or []
            gpu["available"] = bool(gpus)
            with _snap_lock:
                _current["gpu"] = gpu
            # 多卡：任一卡忙碌即计入 GPU 活跃时长（TP 模式两卡利用率接近，单卡跑独占任务也能覆盖）
            if any((g.get("util") or 0) > 10 for g in gpus):
                _gpu_active_s[0] += SYS_INTERVAL
        except Exception:
            pass
        time.sleep(SYS_INTERVAL)


def system_loop():
    """系统循环：每 2s 快采 CPU/内存/网络/load，每 10s 慢采磁盘/温度/进程/IP"""
    prev_cpu = read_cpu_stat()
    prev_net = read_net()
    prev_t = time.time()
    _phys_n = read_phys_cores()  # 物理核数开机后不变，启动时取一次
    with _snap_lock:
        _current["phys_cores"] = _phys_n
    if psutil is not None:  # 建立基线（非 Linux 降级路径用）
        try:
            psutil.cpu_percent(interval=None, percpu=True)
        except Exception:
            pass
    n = 0
    while True:
        try:
            # --- 慢采样（首拍 + 每 10s）：磁盘 / 温度 / 进程 / IP ---
            if n % SYS_SLOW_TICKS == 0:
                try:
                    _sys_slow["disks"] = read_disks()
                except Exception:
                    pass
                try:
                    _sys_slow["temps"] = read_temps()
                except Exception:
                    pass
                try:
                    _sys_slow["top_procs"] = read_top()
                except Exception:
                    pass
                try:
                    _sys_slow["ip"] = get_ip()
                except Exception:
                    pass

            cur_cpu = read_cpu_stat()
            cur_net = read_net()
            cur_t = time.time()
            dt = cur_t - prev_t

            cores = cpu_pcts(prev_cpu, cur_cpu)
            if not cores and psutil is not None:  # /proc 不可用时降级 psutil
                try:
                    cores = [round(x, 1) for x in psutil.cpu_percent(interval=None, percpu=True)]
                except Exception:
                    cores = []
            cpu_overall = round(sum(cores) / len(cores), 1) if cores else 0.0

            mem = read_mem()
            if not mem.get("mem_total") and psutil is not None:
                try:
                    vm = psutil.virtual_memory()
                    sm = psutil.swap_memory()
                    mem = {"mem_total": vm.total // 1024, "mem_used": vm.used // 1024,
                           "swap_total": sm.total // 1024, "swap_used": sm.used // 1024}
                except Exception:
                    pass

            rx_bps = tx_bps = 0
            if dt > 0:
                rx_bps = int(max(0, cur_net[0] - prev_net[0]) / dt * 8)  # bits/s
                tx_bps = int(max(0, cur_net[1] - prev_net[1]) / dt * 8)

            sysd = {
                "cpu_percent": cpu_overall,
                "cores": cores,                                  # 每核占用 %
                "core_count": len(cores) if cores else (os.cpu_count() or 0),
                "load": read_load(),
                "mem_used": round(mem.get("mem_used", 0) / 1024.0, 1),    # MB
                "mem_total": round(mem.get("mem_total", 0) / 1024.0, 1),
                "swap_used": round(mem.get("swap_used", 0) / 1024.0, 1),
                "swap_total": round(mem.get("swap_total", 0) / 1024.0, 1),
                "net_rx_bps": rx_bps,
                "net_tx_bps": tx_bps,
                "rx_total": cur_net[0],                          # 字节累计
                "tx_total": cur_net[1],
                "uptime_s": read_uptime(),
                "disks": _sys_slow["disks"],
                "temps": _sys_slow["temps"],
                "top_procs": _sys_slow["top_procs"],
            }
            host = {"hostname": HOSTNAME, "ip": _sys_slow["ip"],
                    "uptime_s": sysd["uptime_s"]}
            with _snap_lock:
                _current["system"] = sysd
                _current["host"] = host
            prev_cpu, prev_net, prev_t = cur_cpu, cur_net, cur_t
            n += 1
        except Exception:
            time.sleep(1)
        time.sleep(SYS_FAST_INTERVAL)


# ---------------- 长期工作统计（stats_log.jsonl） ----------------
# 每 60s 一行快照：token 计数器存原始累计值（聚合时差分，自动处理 llama-server 重置），
# 推理忙碌/GPU 活跃存本窗口增量秒（面板重启不影响口径）。

def _stats_record():
    if not INFERENCE_AVAILABLE:
        return  # 无推理组件：不写统计行，避免无意义增长
    now = time.time()
    with _snap_lock:
        gpus = (_current.get("gpu") or {}).get("gpus") or []
        llama = _current.get("llama") or {}
        system = _current.get("system") or {}
        busy_s = _busy_s[0]
        gpu_s = _gpu_active_s[0]
    _busy_s[0] = 0.0
    _gpu_active_s[0] = 0.0
    # 多卡聚合（2026-09-23 双卡化）：利用率取均值、温度取峰值、功耗求和、显存合并。
    # 行格式不变（u/temp/pwr/vr 口径升级为全卡），旧数据为单卡口径，窗口聚合自然过渡。
    utils = [g.get("util") for g in gpus if g.get("util") is not None]
    temps = [g.get("temp") for g in gpus if g.get("temp") is not None]
    powers = [g.get("power") for g in gpus if g.get("power") is not None]
    mem_used = sum((g.get("mem_used") or 0) for g in gpus)
    vram_total = sum((g.get("mem_total") or 0) for g in gpus)
    util = round(sum(utils) / len(utils), 1) if utils else None
    temp = max(temps) if temps else None
    power = round(sum(powers), 2) if powers else None
    vram_pct = (mem_used / float(vram_total) * 100) if vram_total else None
    mem_total = system.get("mem_total") or 0
    mem_pct = ((system.get("mem_used") or 0) / float(mem_total) * 100) if mem_total else None
    elapsed = max(0.0, now - _stats_prev_t[0]) if _stats_prev_t[0] else 0.0
    _stats_prev_t[0] = now
    covered = min(elapsed, STATS_INTERVAL * 2.5) if elapsed else 0.0
    proxy = llama.get("proxy") or {}
    if LLM_KIND in ("vllm", "fastllm", "openai"):
        # 忙碌口径:代理在账时用真实请求活动(fast 循环按 llama.busy 累计);
        # 无代理时退回 GPU 均值利用率>15% 代理
        if not proxy.get("enabled") and (util or 0) > 15:
            busy_s = covered
        tps_now = llama.get("tot_recent_tps") or None  # 真实(代理)优先,探测兜底
    else:
        tps_now = llama.get("tot_recent_tps") if (llama.get("busy") or 0) > 0 else None
    # 真实吞吐与探测吞吐分账:tpr 只存真实流量样本(代理在账时的 tps / llama.cpp 忙碌 tps);
    # 流式估算样本(recent_est)不进 tpr,避免字符折算值冒充"真实均值"
    tps_is_real = bool((proxy.get("enabled") and proxy.get("recent_tps")
                         and not proxy.get("recent_est")) or
                        (LLM_KIND == "vllm" and llama.get("telemetry_source") == "engine"
                         and llama.get("tot_recent_tps") is not None) or
                        (LLM_KIND == "llamacpp" and (llama.get("busy") or 0) > 0))
    row = {
        "t": round(now, 1),
        "ts": datetime.fromtimestamp(now).strftime("%Y-%m-%d %H:%M:%S"),
        "bs": round(busy_s, 1),
        "gs": round(gpu_s, 1),
        "cv": round(covered, 1),
        "u": util,
        "ub": util if busy_s > 0 else None,
        "temp": temp,
        "pwr": power,
        "e": round((power or 0) * covered / 3600.0, 4),
        "vr": round(vram_pct, 1) if vram_pct is not None else None,
        "cpu": system.get("cpu_percent"),
        "mem": round(mem_pct, 1) if mem_pct is not None else None,
        "rx": system.get("net_rx_bps"),
        "tx": system.get("net_tx_bps"),
        "tps": tps_now,
    }
    if tps_now is not None and tps_is_real:
        row["tpr"] = tps_now
    if LLM_KIND in ("vllm", "fastllm", "openai") and proxy.get("enabled"):
        # 代理账本:累计计数器原值入行,聚合层差分(面板重启清零=计数器回落,该段自动丢弃)
        row["pgt"] = proxy.get("sess_c") or 0
        row["ppt"] = proxy.get("sess_p") or 0
        row["pcch"] = proxy.get("sess_cache") or 0
        row["preq"] = proxy.get("reqs") or 0
        row["prt"] = round(proxy.get("sess_rtt") or 0, 1)
    try:
        m = LLM_SAMPLER.metrics()
        row["gt"] = m.get("llamacpp:tokens_predicted_total")
        row["pt"] = m.get("llamacpp:prompt_tokens_total")
        row["ps"] = round(m.get("llamacpp:tokens_predicted_seconds_total") or 0, 3)
        row["prs"] = round(m.get("llamacpp:prompt_seconds_total") or 0, 3)
        # 投机解码（MTP）：draft/accepted 累计计数器，聚合时算接受率
        row["dt"] = m.get("llamacpp:spec_decode_num_draft_tokens_total")
        row["at"] = m.get("llamacpp:spec_decode_num_accepted_tokens_total")
        # 缓存命中 token（与实际计算的 prompt token 是两个独立计数器，相加 = 输入总量）
        row["ct"] = m.get("llamacpp:prompt_tokens_cached_total")
    except Exception:
        pass  # llama 离线：该行只记忙闲/系统指标
    try:
        with open(STATS_LOG, "a") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _stats_prune():
    """删除超过保留期（默认 3 年）的旧行"""
    if not os.path.exists(STATS_LOG):
        return
    cutoff = time.time() - STATS_RETENTION_DAYS * 86400
    kept = []
    try:
        with open(STATS_LOG, "r") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("t", 0) >= cutoff:
                    kept.append(line if line.endswith("\n") else line + "\n")
        tmp = STATS_LOG + ".tmp"
        with open(tmp, "w") as f:
            f.writelines(kept)
        os.replace(tmp, STATS_LOG)
    except Exception:
        pass


def _stats_compact():
    """30 天前的逐分钟记录压缩为逐小时摘要，保留计数器末值与能耗/覆盖度。"""
    if not os.path.exists(STATS_LOG):
        return
    cutoff = time.time() - STATS_DETAIL_DAYS * 86400
    recent, groups = [], {}
    try:
        with open(STATS_LOG, "r") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                t = r.get("t", 0)
                if t >= cutoff:
                    recent.append(r)
                    continue
                key = int(t // 3600)
                g = groups.setdefault(key, {
                    "last": None, "n": 0, "bs": 0.0, "gs": 0.0, "cv": 0.0, "e": 0.0,
                    "u_sum": 0.0, "u_n": 0, "ub_sum": 0.0, "ub_n": 0, "temp_max": None,
                    "pwr_sum": 0.0, "pwr_n": 0, "pwr_max": None,
                    "cpu_sum": 0.0, "cpu_n": 0, "mem_sum": 0.0, "mem_n": 0,
                    "tps_sum": 0.0, "tps_n": 0, "tps_max": None,
                    "tpr_sum": 0.0, "tpr_n": 0,
                    "prev_p": None,
                    "pgt_d": 0.0, "ppt_d": 0.0, "pcch_d": 0.0, "preq_d": 0.0, "prt_d": 0.0,
                })
                g["last"] = r if g["last"] is None or t >= g["last"].get("t", 0) else g["last"]
                n = max(1, int(r.get("n") or 1))
                g["n"] += n
                for fld in ("bs", "gs", "cv", "e"):
                    g[fld] += r.get(fld) or 0
                for fld, sf, nf in (("u", "u_sum", "u_n"), ("ub", "ub_sum", "ub_n"),
                                    ("pwr", "pwr_sum", "pwr_n"),
                                    ("cpu", "cpu_sum", "cpu_n"), ("mem", "mem_sum", "mem_n"),
                                    ("tps", "tps_sum", "tps_n")):
                    if r.get(sf) is not None:
                        g[sf] += r.get(sf) or 0
                        g[nf] += int(r.get(nf) or 0)
                    elif r.get(fld) is not None:
                        g[sf] += float(r[fld])
                        g[nf] += 1
                for fld, target in (("temp", "temp_max"), ("pwr", "pwr_max"), ("tps", "tps_max")):
                    v = r.get(target) if r.get(target) is not None else r.get(fld)
                    if v is not None:
                        g[target] = v if g[target] is None else max(g[target], v)
                # 代理计数器组内差分:小时内的重启回落不再丢失之前的增量
                if r.get("pgt") is not None:
                    pv = g["prev_p"]
                    if pv is not None:
                        g["pgt_d"] += max(0.0, r["pgt"] - pv.get("pgt", 0))
                        g["ppt_d"] += max(0.0, (r.get("ppt") or 0) - (pv.get("ppt") or 0))
                        g["pcch_d"] += max(0.0, (r.get("pcch") or 0) - (pv.get("pcch") or 0))
                        g["preq_d"] += max(0.0, (r.get("preq") or 0) - (pv.get("preq") or 0))
                        g["prt_d"] += max(0.0, (r.get("prt") or 0) - (pv.get("prt") or 0))
                    g["prev_p"] = r
                # 真实吞吐进摘要(超物理上限的毛刺在此一并剔除)
                if r.get("tpr") is not None and float(r["tpr"]) <= _tps_cap():
                    g["tpr_sum"] += float(r["tpr"])
                    g["tpr_n"] += 1
        compacted = []
        for key in sorted(groups):
            g = groups[key]
            last = dict(g.pop("last") or {})
            # 原始采样字段由摘要字段替代，避免误当成单点重复累计。
            for fld in ("u", "ub", "temp", "pwr", "cpu", "mem", "tps", "vr", "rx", "tx", "tpr"):
                last.pop(fld, None)
            last["tpr_sum"] = g.pop("tpr_sum")
            last["tpr_n"] = g.pop("tpr_n")
            for fld in ("pgt_d", "ppt_d", "pcch_d", "preq_d", "prt_d"):
                last[fld] = g.pop(fld)
            g.pop("prev_p", None)
            last.update(g)
            last["agg"] = 1
            last["ts"] = datetime.fromtimestamp(key * 3600).strftime("%Y-%m-%d %H:00:00")
            compacted.append(last)
        all_rows = compacted + recent
        all_rows.sort(key=lambda r: r.get("t", 0))
        tmp = STATS_LOG + ".compact"
        with open(tmp, "w") as f:
            for r in all_rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        os.replace(tmp, STATS_LOG)
    except Exception:
        pass


def _stats_rebuild():
    """全量扫描 stats_log，聚合出 24h/7d/30d/1y 窗口与 小时/天/周 分桶，缓存供 /api/stats"""
    rows = []
    try:
        with open(STATS_LOG, "r") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    rows.sort(key=lambda r: r.get("t", 0))
    now = time.time()
    WINS = [("24h", 86400), ("7d", 7 * 86400), ("30d", 30 * 86400),
            ("1y", 365 * 86400), ("3y", 3 * 365 * 86400)]

    def _new_acc():
        return {"gt": 0.0, "pt": 0.0, "ct": 0.0, "ps": 0.0, "dt": 0.0, "at": 0.0,
                "bs": 0.0, "gs": 0.0, "cv": 0.0, "e": 0.0, "sample_n": 0,
                "u_sum": 0.0, "u_n": 0, "ub_sum": 0.0, "ub_n": 0, "temp_max": None,
                "pwr_sum": 0.0, "pwr_n": 0, "pwr_max": None,
                "cpu_sum": 0.0, "cpu_n": 0, "mem_sum": 0.0, "mem_n": 0,
                "tps_sum": 0.0, "tps_n": 0, "tps_max": None, "tps_vals": [],
                "tpr_sum": 0.0, "tpr_n": 0, "tpr_vals": [],
                "pgt": 0.0, "ppt": 0.0, "pcch": 0.0, "preq": 0.0, "prt": 0.0}

    accs = {}
    for k, _s in WINS:
        accs[k] = _new_acc()
    hacc, dacc, wacc = {}, {}, {}  # 分桶：小时 / 天 / 周

    def _bucket_for(t):
        out = []
        if t >= now - 86400:
            out.append(hacc.setdefault(int(t // 3600), _new_acc()))
        if t >= now - 30 * 86400:
            day = datetime.fromtimestamp(t).strftime("%Y-%m-%d")
            out.append(dacc.setdefault(day, _new_acc()))
        dt_ = datetime.fromtimestamp(t)
        ws = (dt_ - timedelta(days=dt_.weekday())).strftime("%Y-%m-%d")  # 周一为界
        out.append(wacc.setdefault(ws, _new_acc()))
        return out

    def _add_values(a, r):
        n = max(1, int(r.get("n") or 1))
        a["sample_n"] += n
        a["bs"] += r.get("bs") or 0
        a["gs"] += r.get("gs") or 0
        a["cv"] += r.get("cv") if r.get("cv") is not None else min(60.0 * n, 3600.0)
        a["e"] += r.get("e") or 0
        # 吞吐脏样本(超物理上限的差分毛刺)在入账前剔除,均值/峰值/P95 一并受保护
        _cap = _tps_cap()
        _r = r
        if (r.get("tps") is not None and float(r["tps"]) > _cap) or \
                (r.get("tpr") is not None and float(r["tpr"]) > _cap):
            _r = dict(r)
            if _r.get("tps") is not None and float(_r["tps"]) > _cap:
                _r["tps"] = None
            if _r.get("tpr") is not None and float(_r["tpr"]) > _cap:
                _r["tpr"] = None
        for fld, sf, nf in (("u", "u_sum", "u_n"), ("ub", "ub_sum", "ub_n"),
                            ("pwr", "pwr_sum", "pwr_n"),
                            ("cpu", "cpu_sum", "cpu_n"), ("mem", "mem_sum", "mem_n"),
                            ("tps", "tps_sum", "tps_n"), ("tpr", "tpr_sum", "tpr_n")):
            if _r.get(sf) is not None:
                a[sf] += _r.get(sf) or 0
                a[nf] += int(_r.get(nf) or 0)
            elif _r.get(fld) is not None:
                a[sf] += float(_r[fld])
                a[nf] += 1
        tmax = _r.get("temp_max") if _r.get("temp_max") is not None else _r.get("temp")
        if tmax is not None:
            a["temp_max"] = tmax if a["temp_max"] is None else max(a["temp_max"], tmax)
        for fld, target in (("pwr", "pwr_max"), ("tps", "tps_max")):
            v = _r.get(target) if _r.get(target) is not None else _r.get(fld)
            if v is not None:
                a[target] = v if a[target] is None else max(a[target], v)
        # 详细层保留吞吐分布，30 天后压缩层只保留平均/峰值。
        # (脏样本已在 _r 中剔除)
        if _r.get("tps") is not None:
            a["tps_vals"].append(float(_r["tps"]))
        if _r.get("tpr") is not None:
            a["tpr_vals"].append(float(_r["tpr"]))

    prev = None
    prev_p = None  # 代理计数器独立跟踪(仅 openai 时代的行带 pgt)
    for r in rows:
        t = r.get("t", 0)
        if t < now - max(s for _, s in WINS):   # 扫描边界=最大统计窗口(3年),勿用固定 365 天
            continue
        for k, s in WINS:
            if t >= now - s:
                _add_values(accs[k], r)
        for b in _bucket_for(t):
            _add_values(b, r)
        if r.get("pgt_d") is not None:
            # 压缩行自带组内差分(小时重启不丢增量),直接入账
            for k, s in WINS:
                if t >= now - s:
                    a = accs[k]
                    a["pgt"] += r["pgt_d"]
                    a["ppt"] += r.get("ppt_d") or 0
                    a["pcch"] += r.get("pcch_d") or 0
                    a["preq"] += r.get("preq_d") or 0
                    a["prt"] += r.get("prt_d") or 0
            if r.get("pgt") is not None:
                prev_p = r
        elif r.get("pgt") is not None:
            if prev_p is not None:
                # 代理计数器变小 = 面板重启过 → 这一段差分丢弃
                d_pg = max(0.0, r["pgt"] - prev_p.get("pgt", 0))
                d_pp = max(0.0, (r.get("ppt") or 0) - (prev_p.get("ppt") or 0))
                d_pc = max(0.0, (r.get("pcch") or 0) - (prev_p.get("pcch") or 0))
                d_pr = max(0.0, (r.get("preq") or 0) - (prev_p.get("preq") or 0))
                d_prt = max(0.0, (r.get("prt") or 0) - (prev_p.get("prt") or 0))
                for k, s in WINS:
                    if t >= now - s:
                        a = accs[k]
                        a["pgt"] += d_pg
                        a["ppt"] += d_pp
                        a["pcch"] += d_pc
                        a["preq"] += d_pr
                        a["prt"] += d_prt
                for b in _bucket_for(t):
                    b["pgt"] += d_pg
                    b["ppt"] += d_pp
                    b["pcch"] += d_pc
                    b["preq"] += d_pr
                    b["prt"] += d_prt
            prev_p = r
        gt = r.get("gt")
        if gt is not None:
            if prev is not None:
                # 计数器变小 = llama-server 重启过 → 这一段差分丢弃
                d_gt = max(0.0, gt - prev.get("gt", 0))
                d_pt = max(0.0, (r.get("pt") or 0) - (prev.get("pt") or 0))
                d_ps = max(0.0, (r.get("ps") or 0) - (prev.get("ps") or 0))
                d_dt = max(0.0, (r.get("dt") or 0) - (prev.get("dt") or 0))
                d_at = max(0.0, (r.get("at") or 0) - (prev.get("at") or 0))
                d_ct = max(0.0, (r.get("ct") or 0) - (prev.get("ct") or 0))
                for k, s in WINS:
                    if t >= now - s:
                        a = accs[k]
                        a["gt"] += d_gt
                        a["pt"] += d_pt
                        a["ct"] += d_ct
                        a["ps"] += d_ps
                        a["dt"] += d_dt
                        a["at"] += d_at
                for b in _bucket_for(t):
                    b["gt"] += d_gt
                    b["pt"] += d_pt
                    b["ct"] += d_ct
                    b["dt"] += d_dt
                    b["at"] += d_at
            prev = r

    def _pct95(vals):
        if not vals:
            return None
        vals = sorted(vals)
        return vals[min(len(vals) - 1, int(round((len(vals) - 1) * 0.95)))]

    def _finish(a, range_s=None):
        return {
            "tok_gen": round(a["gt"]), "tok_prompt": round(a["pt"]),
            "tok_cached": round(a["ct"]),
            "pred_s": round(a["ps"], 1),
            "busy_s": round(a["bs"], 1), "gpu_active_s": round(a["gs"], 1),
            "avg_tps": round(a["gt"] / a["ps"], 1) if a["ps"] > 0 else None,
            "spec_acc": round(a["at"] / a["dt"] * 100, 1) if a["dt"] > 0 else None,
            "gpu_util_avg": round(a["u_sum"] / a["u_n"], 1) if a["u_n"] else None,
            "gpu_util_busy_avg": round(a["ub_sum"] / a["ub_n"], 1) if a["ub_n"] else None,
            "temp_max": a["temp_max"],
            "power_avg": round(a["pwr_sum"] / a["pwr_n"], 1) if a["pwr_n"] else None,
            "power_max": round(a["pwr_max"], 1) if a["pwr_max"] is not None else None,
            "energy_kwh": round(a["e"] / 1000.0, 3),
            "energy_coverage_pct": round(a["pwr_n"] / float(a["sample_n"]) * 100, 1) if a["sample_n"] else 0,
            "cpu_avg": round(a["cpu_sum"] / a["cpu_n"], 1) if a["cpu_n"] else None,
            "mem_avg": round(a["mem_sum"] / a["mem_n"], 1) if a["mem_n"] else None,
            "tps_observed_avg": round(a["tps_sum"] / a["tps_n"], 1) if a["tps_n"] else None,
            "tps_p95": round(_pct95(a["tps_vals"]), 1) if a["tps_vals"] else None,
            "tps_peak": round(a["tps_max"], 1) if a["tps_max"] is not None else None,
            "tps_real_avg": round(a["tpr_sum"] / a["tpr_n"], 1) if a["tpr_n"] else None,
            "tps_real_p95": round(_pct95(a["tpr_vals"]), 1) if a["tpr_vals"] else None,
            "proxy_tok_gen": round(a["pgt"]),
            "proxy_tok_prompt": round(a["ppt"]),
            "proxy_cache": round(a["pcch"]),
            "proxy_reqs": int(round(a["preq"])),
            "proxy_gen_s": round(a["prt"], 1),
            "coverage_pct": round(min(100.0, a["cv"] / range_s * 100), 1) if range_s else None,
            "samples": a["sample_n"],
        }

    # 稠密分桶：没数据的时间格补 0，前端柱状图才有连续时间轴
    def _bucket_val(acc, key):
        a = acc.get(key) or _new_acc()
        f = _finish(a)
        return {"tok": round(a["gt"]), "busy_s": round(a["bs"], 1),
                "tps": f["tps_observed_avg"], "gpu": f["gpu_util_avg"],
                "energy_kwh": f["energy_kwh"],
                "ptok": round(a["pgt"]), "preq": int(round(a["preq"]))}

    hourly = []
    for i in range(23, -1, -1):
        k = int((now - i * 3600) // 3600)
        val = _bucket_val(hacc, k)
        val["label"] = datetime.fromtimestamp(k * 3600).strftime("%d日 %H:00")
        hourly.append(val)
    today = datetime.fromtimestamp(now).date()
    daily = []
    for i in range(29, -1, -1):
        day = (today - timedelta(days=i)).strftime("%Y-%m-%d")
        val = _bucket_val(dacc, day)
        val["label"] = day[5:]
        daily.append(val)
    week0 = today - timedelta(days=today.weekday())
    weekly = []
    for i in range(156, -1, -1):
        ws = (week0 - timedelta(days=7 * i)).strftime("%Y-%m-%d")
        val = _bucket_val(wacc, ws)
        val["label"] = ws[5:]
        weekly.append(val)

    cache = {
        "ready": True,
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "data_from": rows[0].get("ts") if rows else None,
        "rows": len(rows),
        "windows": {},
        "buckets": {"hourly": hourly, "daily": daily, "weekly": weekly},
    }
    for k, _s in WINS:
        cache["windows"][k] = _finish(accs[k], _s)
    with _stats_lock:
        _stats_cache.clear()
        _stats_cache.update(cache)


def stats_loop():
    _stats_prune()
    _stats_compact()
    last_day = datetime.now().strftime("%Y-%m-%d")
    while True:
        try:
            _stats_record()
            _stats_rebuild()
        except Exception:
            pass
        if datetime.now().strftime("%Y-%m-%d") != last_day:  # 每天 prune 一次
            last_day = datetime.now().strftime("%Y-%m-%d")
            _stats_prune()
            _stats_compact()
        time.sleep(STATS_INTERVAL)


PAGE = r"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#080d18">
<title>统一监控面板</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3' y='3' width='18' height='18' rx='4' fill='%237db8ff'/%3E%3Crect x='7.5' y='7.5' width='9' height='9' rx='2' fill='%230d1220'/%3E%3C/svg%3E">
<style>
:root{
  --bg:#080d18; --bg2:#0c1322; --card:rgba(17,25,43,.88); --card2:#141e32;
  --line:rgba(148,163,184,.12); --line-strong:rgba(148,163,184,.22);
  --fg:#f2f6ff; --dim:#94a2bb; --dim2:#63708a;
  --gpu:#ff765e; --ram:#58a6ff; --cpu:#67e8a5; --disk:#bd8cff;
  --temp:#fbc85b; --warn:#fbc85b; --err:#ff6f7d; --ok:#67e8a5;
  --accent:#79aaff; --accent2:#6ee7d8;
  --r:16px; --shadow:0 18px 50px rgba(0,0,0,.18);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{
  background:
    radial-gradient(1000px 560px at 92% -8%, rgba(88,166,255,.12), transparent 62%),
    radial-gradient(820px 520px at -8% 92%, rgba(110,231,216,.07), transparent 62%),
    var(--bg);
  color:var(--fg);
  font:14px/1.55 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  padding:0 clamp(14px,3vw,42px) 34px;
  max-width:1600px;margin:0 auto;min-height:100vh;
}
h1{font-size:23px;font-weight:720;letter-spacing:-.35px}
.brand{display:flex;align-items:center;gap:12px}
.brandmark{width:37px;height:37px;border-radius:11px;display:grid;place-items:center;flex:none;
  background:linear-gradient(145deg,rgba(121,170,255,.24),rgba(110,231,216,.10));
  border:1px solid rgba(121,170,255,.3);box-shadow:inset 0 1px 0 rgba(255,255,255,.1)}
.brandmark svg{width:22px;height:22px;display:block}
.eyebrow{font-size:10px;color:var(--accent);letter-spacing:1.8px;text-transform:uppercase;font-weight:700;margin-bottom:1px}
.ver{font-size:10.5px;color:#7db8ff;border:1px solid rgba(77,163,255,.35);
     padding:1px 8px;border-radius:999px;vertical-align:3px;margin-left:6px;letter-spacing:.5px}
.sub{color:var(--dim);font-size:12.5px;margin-top:4px}
header{position:sticky;top:0;z-index:30;display:flex;justify-content:space-between;align-items:center;
  gap:18px;flex-wrap:wrap;margin:0 calc(clamp(14px,3vw,42px) * -1);padding:16px clamp(14px,3vw,42px) 13px;
  background:linear-gradient(180deg,rgba(8,13,24,.96),rgba(8,13,24,.84));
  border-bottom:1px solid rgba(148,163,184,.08);backdrop-filter:blur(18px)}
.hdr-right{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 11px;
      border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.03);white-space:nowrap}
.pill .dot{width:7px;height:7px;border-radius:50%;background:var(--dim2)}
.pill.ok .dot{background:var(--ok);box-shadow:0 0 8px rgba(126,224,129,.8)}
.pill.off .dot{background:var(--err)}
.pill.dim{color:var(--dim)}
.banner{margin:14px 0 0;padding:11px 14px;border-radius:12px;font-size:13px;
        background:rgba(255,107,107,.10);border:1px solid rgba(255,107,107,.35);color:#ffb4b4}
.hidden{display:none!important}
.control{height:30px;border:1px solid var(--line);border-radius:9px;background:rgba(255,255,255,.035);
  color:var(--dim);font-family:inherit;font-size:12px;font-weight:600;line-height:1;padding:0 10px;cursor:pointer;transition:.16s ease}
.control:hover{color:var(--fg);border-color:var(--line-strong);background:rgba(255,255,255,.06)}
.control.active{color:#0b1422;background:var(--warn);border-color:var(--warn)}
.control svg{width:13px;height:13px;vertical-align:-2px;margin-right:4px}
.overview{display:grid;grid-template-columns:minmax(220px,1.35fr) repeat(3,minmax(150px,.8fr));gap:10px;margin:18px 0 0}
.overview-item{min-height:72px;padding:12px 14px;border-radius:13px;border:1px solid var(--line);
  background:linear-gradient(145deg,rgba(255,255,255,.04),rgba(255,255,255,.012));display:flex;flex-direction:column;justify-content:center}
.overview-item.primary{background:linear-gradient(135deg,rgba(121,170,255,.13),rgba(110,231,216,.045));border-color:rgba(121,170,255,.2)}
.overview-label{color:var(--dim2);font-size:10.5px;letter-spacing:1px;text-transform:uppercase}
.overview-value{font-size:16px;font-weight:650;margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.overview-value small{font-size:11px;color:var(--dim);font-weight:500;margin-left:4px}
/* ---- Tab ---- */
.tabs{display:flex;gap:5px;margin:14px 0 0;padding:4px;width:max-content;border:1px solid var(--line);
  border-radius:12px;background:rgba(255,255,255,.025)}
.tabbtn{background:rgba(255,255,255,.04);border:1px solid var(--line);color:var(--dim);
  font:inherit;font-size:13px;font-weight:650;padding:7px 24px;border-radius:8px;cursor:pointer;
  letter-spacing:1px;transition:all .15s}
.tabbtn:hover{color:var(--fg);border-color:rgba(148,163,184,.3)}
.tabbtn.on{color:#07101d;background:linear-gradient(135deg,var(--accent),#87c8ff);border-color:transparent;box-shadow:0 5px 16px rgba(88,166,255,.22)}
/* ---- 指标卡片 ---- */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:14px;margin:18px 0 4px}
.telemetry-grid{grid-template-columns:repeat(6,minmax(0,1fr))}
.card{position:relative;background:linear-gradient(155deg,rgba(255,255,255,.045),rgba(255,255,255,0) 55%),var(--card);
      border:1px solid var(--line);border-radius:var(--r);padding:14px 16px 8px;overflow:hidden;box-shadow:0 10px 28px rgba(0,0,0,.08);
      transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}
.card:hover{transform:translateY(-2px);border-color:var(--line-strong);box-shadow:var(--shadow)}
.card::before{content:"";position:absolute;left:0;top:0;right:0;height:3px;background:var(--c,#334466)}
.card .label{color:var(--dim);font-size:12px;letter-spacing:.3px}
.card .value{font-size:clamp(21px,1.9vw,26px);font-weight:650;margin-top:6px;
             font-variant-numeric:tabular-nums;letter-spacing:.3px}
.card .value small{font-size:13px;color:var(--dim);font-weight:500}
.card .extra{color:var(--dim);font-size:12px;margin-top:2px;font-variant-numeric:tabular-nums}
.bar{height:6px;background:rgba(255,255,255,.06);border-radius:99px;margin-top:10px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;background:var(--c);width:0;transition:width .6s ease}
.spark{display:block;width:100%;height:36px;margin-top:8px}
/* ---- 面板 ---- */
.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
       padding:17px 19px;margin:16px 0;box-shadow:0 10px 30px rgba(0,0,0,.07);backdrop-filter:blur(8px)}
.panel h2{font-size:13px;color:var(--dim);font-weight:600;letter-spacing:.4px;margin-bottom:12px;
          display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.panel h2 .title{color:#b9c5dd;font-weight:600}
.scroller{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--dim2);font-size:11px;font-weight:600;letter-spacing:.7px;text-align:left;
   padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.06);
   font-variant-numeric:tabular-nums;white-space:nowrap}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:rgba(255,255,255,.02)}
.section-note{color:var(--dim2);font-size:11px;font-weight:400;letter-spacing:0}
.mono{font-family:"Cascadia Code",Consolas,monospace;font-size:12px;color:#b9c5dd}
.err{color:var(--err)}
.dim{color:var(--dim)}
/* 状态 */
.st{display:inline-flex;align-items:center;gap:6px;font-size:12.5px}
.st .dot{width:7px;height:7px;border-radius:50%}
.st.busy{color:var(--warn)}
.st.busy .dot{background:var(--warn);animation:pulse 1.2s ease-in-out infinite}
.st.idle{color:var(--dim)}
.st.idle .dot{background:var(--dim2)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.tag{background:rgba(77,163,255,.15);color:#7db8ff;border-radius:5px;
     padding:1px 7px;font-size:11px;margin-left:8px;white-space:nowrap}
/* 上下文进度条 */
.ctx{display:flex;align-items:center;gap:9px}
.ctxbar{width:96px;height:5px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden;flex:none}
.ctxbar i{display:block;height:100%;border-radius:99px}
.ctx span{color:#b9c5dd;font-size:12.5px}
/* 趋势图 */
#chart,#syschart{width:100%;height:175px;display:block}
.legend{margin-left:auto;display:flex;gap:14px;align-items:center;font-weight:400}
.chip{display:inline-flex;align-items:center;gap:6px;color:var(--dim);font-size:12px}
#llama_chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}
#llama_chips .chip{background:rgba(255,255,255,.03);border:1px solid var(--line);
  border-radius:999px;padding:3.5px 11px}
.chip i{width:9px;height:9px;border-radius:3px;display:inline-block}
.chip b{color:var(--fg);font-variant-numeric:tabular-nums}
.foot{color:var(--dim2);font-size:11.5px;text-align:center;margin-top:24px}
/* ---- 系统页 ---- */
.hostrow{display:flex;gap:34px;flex-wrap:wrap}
.hostrow .hlabel{color:var(--dim2);font-size:11px;letter-spacing:.6px;margin-bottom:3px}
.hostrow .hval{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.hostrow .hval.mono{font-size:15px}
.corebar{display:flex;gap:2px;margin-top:10px;height:38px;align-items:flex-end}
.corebar i{flex:1;background:var(--cpu);border-radius:2px;min-height:2px;transition:height .5s}
.corebar i.hot{background:var(--warn)}
.corebar i.crit{background:var(--err)}
.dbar{margin:8px 0}
.dbar .lbl{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;margin-bottom:4px;flex-wrap:wrap}
.track{height:8px;background:rgba(255,255,255,.06);border-radius:99px;overflow:hidden}
.fill{height:100%;background:var(--ok);border-radius:99px;transition:width .5s}
.fill.warn{background:var(--warn)} .fill.crit{background:var(--err)}
.tempgrid{display:flex;flex-wrap:wrap;gap:7px}
.halfrow{display:flex;gap:14px;flex-wrap:wrap}
.halfrow > .panel{flex:1 1 calc(50% - 8px);min-width:340px}
.chipgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:7px}
.corechip{position:relative;border:1px solid var(--line);border-radius:8px;padding:6px 8px 10px;font-size:11px;color:var(--dim);text-align:center;overflow:hidden;background:rgba(255,255,255,0.02)}
.corechip .cl{display:block}
.corechip b{display:block;color:#3fbf6f;font-family:Consolas,monospace;font-size:13.5px;margin-top:2px}
.corechip .bar{position:absolute;left:0;bottom:0;height:3px;background:#3fbf6f;border-radius:2px}
.corechip.hot{border-color:var(--warn)}
.corechip.hot b{color:var(--warn)}
.corechip.hot .bar{background:var(--warn)}
.corechip.crit{border-color:var(--err);color:var(--err)}
.corechip.crit b{color:var(--err)}
.corechip.crit .bar{background:var(--err)}
.tempchip{border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:11.5px;color:var(--dim)}
.tempchip b{display:block;color:var(--fg);font-family:Consolas,monospace;font-size:13.5px;margin-top:2px}
.tempchip.hot{border-color:var(--warn)}
.tempchip.crit{border-color:var(--err);color:var(--err)}
.netrow{display:flex;gap:26px;flex-wrap:wrap;align-items:baseline}
.netrow .big{font-size:19px;font-weight:650;font-variant-numeric:tabular-nums}
.netrow .big small{font-size:12px;color:var(--dim);font-weight:500}
/* 空状态 */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:100px 20px;text-align:center;color:var(--dim)}
.empty-ring{width:66px;height:66px;border:3px solid rgba(148,163,184,.22);border-radius:50%;
  position:relative;margin-bottom:20px}
.empty-ring::after{content:"";position:absolute;left:50%;top:50%;width:26px;height:3px;
  background:rgba(148,163,184,.32);border-radius:2px;transform:translate(-50%,-50%) rotate(45deg)}
.empty-title{font-size:17px;color:#b9c5dd;font-weight:600}
.empty-sub{font-size:13px;color:var(--dim2);margin-top:8px}
/* GPU 表格：双卡服务器并排，单表时占满宽度 */
.hardware-grid{display:grid;grid-template-columns:minmax(0,.82fr) minmax(0,1.18fr);gap:14px;margin:16px 0}
.hardware-grid.single{grid-template-columns:minmax(0,1fr)}
.hardware-grid .panel{min-width:0;margin:0;overflow-x:auto}
.hardware-grid .panel.hidden{display:none}
/* 工作统计 */
.stab{font-size:12px;color:var(--dim);border:1px solid var(--line);background:rgba(255,255,255,.03);
      border-radius:999px;padding:3px 12px;cursor:pointer;font-family:inherit}
.stab.on{color:#0d1220;background:#7db8ff;border-color:#7db8ff;font-weight:600}
.stats-head{margin-bottom:14px}
.stats-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px 20px;flex-wrap:wrap}
.stats-heading h2{margin-bottom:0}
.stats-heading .sub{font-size:11px;color:var(--dim2)}
.stats-controls{display:flex;align-items:center;justify-content:space-between;gap:10px 18px;
  flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.stats-control-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.stats-control-label{font-size:11px;color:var(--dim2);white-space:nowrap}
#stats_tabs,#stats_metric{display:flex;gap:6px;flex-wrap:wrap}
#stats_cards{grid-template-columns:repeat(10,minmax(0,1fr));gap:10px;margin:6px 0 14px}
#stats_cards .card{grid-column:span 2;min-width:0;min-height:98px;padding:13px 15px 12px}
#stats_cards .card.stat-primary{grid-column:span 5;min-height:112px}
#stats_cards .card .value{font-size:21px}
#stats_cards .card.stat-primary .value{font-size:clamp(25px,2.4vw,31px)}
#stats_cards .card .extra{line-height:1.35;margin-top:5px}
.stats-chart{width:100%;height:190px;display:block}
#stats_tip{position:fixed;display:none;z-index:50;pointer-events:none;
  background:rgba(13,18,32,.96);border:1px solid rgba(148,163,184,.25);border-radius:8px;
  padding:7px 11px;font-size:12px;line-height:1.7;color:var(--fg);
  box-shadow:0 4px 16px rgba(0,0,0,.45);max-width:min(260px,calc(100vw - 16px));
  white-space:normal;font-variant-numeric:tabular-nums}
.analysis-wrap{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.7fr);gap:12px;margin:14px 0 2px}
.analysis-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
.analysis-card{border:1px solid var(--line);border-radius:12px;padding:11px 12px;background:rgba(255,255,255,.022)}
.analysis-card .alabel{font-size:10.5px;color:var(--dim2);letter-spacing:.7px;text-transform:uppercase}
.analysis-card .avalue{font-size:18px;font-weight:680;margin-top:3px;font-variant-numeric:tabular-nums}
.analysis-card .asub{font-size:11px;color:var(--dim);margin-top:2px}
.insights{border:1px solid rgba(121,170,255,.18);border-radius:12px;padding:12px 14px;
  background:linear-gradient(145deg,rgba(121,170,255,.08),rgba(110,231,216,.025))}
.insights h3{font-size:11px;color:var(--accent);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px}
.insights ul{list-style:none;display:grid;gap:7px}
.insights li{position:relative;padding-left:14px;color:#c7d1e5;font-size:12px;line-height:1.45}
.insights li::before{content:"";position:absolute;left:0;top:.55em;width:5px;height:5px;border-radius:50%;background:var(--accent2)}
.score{display:inline-flex;align-items:baseline;gap:4px}.score b{font-size:26px}.score small{color:var(--dim);font-size:11px}
@media (max-width:1350px){
  .telemetry-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (max-width:1100px){
  .hardware-grid{grid-template-columns:minmax(0,1fr)}
  #stats_cards{grid-template-columns:repeat(6,minmax(0,1fr))}
  #stats_cards .card.stat-primary{grid-column:span 3}
  #stats_cards .card:nth-last-child(-n+2){grid-column:span 3}
}
/* ---- 移动端 ---- */
@media (max-width:720px){
  body{padding:0 12px 24px}
  header{position:relative;margin:0 -12px;padding:14px 12px 12px;align-items:flex-start}
  .hdr-right{width:100%}
  .overview{grid-template-columns:repeat(2,1fr)}
  .overview-item{min-height:66px;padding:10px 11px}
  .overview-item.primary{grid-column:1 / -1}
  .overview-value{font-size:14px}
  .analysis-wrap{grid-template-columns:1fr}
  .analysis-grid{grid-template-columns:repeat(2,1fr)}
  .grid{grid-template-columns:repeat(2,1fr);gap:10px}
  .telemetry-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  #stats_cards{grid-template-columns:repeat(2,minmax(0,1fr))}
  #stats_cards .card,#stats_cards .card.stat-primary,#stats_cards .card:nth-last-child(-n+2){grid-column:span 1}
  #stats_cards .card:last-child{grid-column:span 2}
  .stats-controls{align-items:flex-start;flex-direction:column}
  .stats-chart{height:170px}
  .card{padding:11px 12px 6px}
  .spark{height:28px}
  .panel{padding:13px 13px}
  #chart,#syschart{height:140px}
  .hostrow{gap:18px}
  table.stack thead{display:none}
  table.stack tr{display:block;padding:9px 0;border-bottom:1px solid rgba(148,163,184,.08)}
  table.stack td{display:flex;justify-content:space-between;align-items:center;gap:10px;
                 padding:3.5px 0;border:none}
  table.stack td::before{content:attr(data-th);color:var(--dim);font-size:12px;flex:none}
  table.stack tr:last-child{border-bottom:none}
}
@media (max-width:430px){
  .grid{grid-template-columns:1fr}
  .telemetry-grid{grid-template-columns:1fr}
  #stats_cards{grid-template-columns:1fr}
  #stats_cards .card:last-child{grid-column:span 1}
  .overview{grid-template-columns:1fr 1fr}
  .overview-item:last-child{grid-column:1 / -1}
  .analysis-grid{grid-template-columns:1fr 1fr}
  .pill#uptime{display:none}
  .tabbtn{padding:7px 20px}
}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="brandmark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 16.5v-9Z" stroke="#79aaff" stroke-width="1.5"/><path d="M9 15V9m3 6v-3m3 3v-5" stroke="#6ee7d8" stroke-width="1.8" stroke-linecap="round"/></svg></div>
    <div>
      <div class="eyebrow">AI COMPUTE OBSERVATORY</div>
      <h1>统一监控面板</h1>
      <div class="sub"><span id="gname">…</span> · <span id="age">正在获取最新遥测</span></div>
    </div>
  </div>
  <div class="hdr-right">
    <span id="inf_pill" class="pill"><span class="dot"></span>推理检测中…</span>
    <span id="conn" class="pill"><span class="dot"></span>连接中…</span>
    <span id="uptime" class="pill dim">运行 —</span>
    <button id="pause_btn" class="control" type="button" aria-pressed="false">暂停刷新</button>
    <button id="refresh_btn" class="control" type="button" title="立即刷新">立即刷新</button>
  </div>
</header>
<span id="ts" class="hidden"></span><span id="intv" class="hidden"></span>
<section class="overview" aria-label="运行总览">
  <div class="overview-item primary"><span class="overview-label">当前状态</span><span class="overview-value" id="ov_state">等待首个采样…</span></div>
  <div class="overview-item"><span class="overview-label">实时输出</span><span class="overview-value" id="ov_tps">— <small>tok/s</small></span></div>
  <div class="overview-item"><span class="overview-label">GPU 负载</span><span class="overview-value" id="ov_gpu">—</span></div>
  <div class="overview-item"><span class="overview-label" id="ov_slots_label">活跃 Slot</span><span class="overview-value" id="ov_slots">—</span></div>
</section>
<div class="tabs">
  <button class="tabbtn" id="tab_btn_inf" aria-controls="tab_inf">推理</button>
  <button class="tabbtn" id="tab_btn_sys" aria-controls="tab_sys">系统</button>
</div>
<div id="banner" class="banner hidden"></div>

<!-- ============ Tab 1: 推理 ============ -->
<div id="tab_inf">
  <div id="inf_notice" class="banner hidden"></div>
  <div id="inf_empty" class="empty hidden">
    <div class="empty-ring"></div>
    <div class="empty-title">本机未部署推理模块</div>
    <div class="empty-sub">GPU 与 llama.cpp 采样不可用</div>
  </div>
  <div id="inf_body">

  <section class="grid telemetry-grid">
    <div class="card" id="card_gpu_util" style="--c:var(--gpu)">
      <div class="label">GPU 利用率</div>
      <div class="value" id="gpu_util">—</div>
      <div class="extra" id="gpu_util_extra"></div>
      <div class="bar"><i id="gpu_util_bar"></i></div>
      <canvas class="spark" id="sp_util"></canvas>
    </div>
    <div class="card" id="card_gpu_mem" style="--c:var(--gpu)">
      <div class="label">显存</div>
      <div class="value" id="gpu_mem">—</div>
      <div class="extra" id="gpu_mem_extra"></div>
      <div class="bar"><i id="gpu_mem_bar"></i></div>
      <canvas class="spark" id="sp_vram"></canvas>
    </div>
    <div class="card" id="card_gpu_temp" style="--c:var(--temp)">
      <div class="label">GPU 温度 / 功耗</div>
      <div class="value" id="gpu_temp">—</div>
      <div class="extra" id="gpu_extra"></div>
      <canvas class="spark" id="sp_temp"></canvas>
    </div>
    <div class="card" style="--c:var(--ram)">
      <div class="label">内存 (RAM)</div>
      <div class="value" id="ram">—</div>
      <div class="extra" id="ram_extra"></div>
      <div class="bar"><i id="ram_bar"></i></div>
      <canvas class="spark" id="sp_ram"></canvas>
    </div>
    <div class="card" style="--c:var(--cpu)">
      <div class="label">CPU</div>
      <div class="value" id="cpu">—</div>
      <div class="bar"><i id="cpu_bar"></i></div>
      <canvas class="spark" id="sp_cpu"></canvas>
    </div>
    <div class="card" style="--c:var(--disk)">
      <div class="label" id="disk_label">磁盘</div>
      <div class="value" id="disk">—</div>
      <div class="extra" id="disk_extra"></div>
      <div class="bar"><i id="disk_bar"></i></div>
    </div>
  </section>

  <section class="panel">
    <h2><span class="title" id="llm_title">llama.cpp 推理</span><span class="section-note">实时任务与吞吐</span>
        <span id="llama_pill" class="pill"><span class="dot"></span>…</span>
        <span id="llama_meta" class="sub" style="margin:0"></span></h2>
    <div id="llama_chips"></div>
    <canvas class="spark" id="sp_llama"></canvas>
    <div id="llama_note" class="section-note" style="display:none;margin-top:8px"></div>
    <div id="llama_cmd" class="mono" style="display:none;margin-top:6px;font-size:11px;color:#8fa0bd;word-break:break-all"></div>
    <div id="active_requests_wrap" class="scroller" style="display:none;margin-top:12px">
      <div class="section-note">活动请求（逐行仅列经 8080 代理的请求；引擎汇总包含直连请求）</div>
      <table><thead><tr><th>请求</th><th>状态</th><th>输入 token</th><th>已生成</th><th>上下文 / 上限</th><th>耗时</th></tr></thead>
      <tbody id="active_requests_tbody"></tbody></table>
    </div>
    <div id="reqlog_wrap" style="display:none;margin-top:12px">
      <div class="section-note" style="margin-bottom:2px">最近请求（经代理 · 新到旧）</div>
      <table>
        <thead><tr><th>时间</th><th>生成 tok</th><th>耗时</th><th>速度</th><th>缓存命中</th></tr></thead>
        <tbody id="reqlog_tbody"></tbody>
      </table>
    </div>
    <div class="scroller" id="slots_wrap">
    <table>
      <thead><tr><th>Slot</th><th>状态</th><th>任务</th><th>3s 速度</th><th>平均速度</th><th>Prompt 速度</th>
      <th>任务时长</th><th>剩余预估</th><th>本轮已生成</th><th>上下文</th><th>投机</th></tr></thead>
      <tbody id="slots_tbody"></tbody>
    </table>
    </div>
  </section>

  <section class="panel">
    <h2><span class="title">趋势（最近 30 分钟）</span><span class="section-note">资源压力一览</span><span id="legend" class="legend"></span></h2>
    <canvas id="chart"></canvas>
  </section>

  <div class="hardware-grid single" id="hardware_grid">
  <section class="panel hidden" id="gpuproc_panel">
    <h2><span class="title">GPU 进程</span><span class="section-note" id="gpuproc_n">占用显存的计算任务</span></h2>
    <table>
      <thead><tr><th>PID</th><th>进程</th><th>卡</th><th>显存 MB</th></tr></thead>
      <tbody id="gpuproc_tbody"></tbody>
    </table>
  </section>

  <section class="panel hidden" id="multi_gpu_panel">
    <h2><span class="title">多 GPU</span></h2>
    <table>
      <thead><tr><th>#</th><th>型号</th><th>利用率</th><th>显存</th><th>温度</th><th>功耗</th><th>风扇</th></tr></thead>
      <tbody id="gpus_tbody"></tbody>
    </table>
  </section>
  </div>

  <section class="panel">
    <div class="stats-head">
      <div class="stats-heading">
        <h2><span class="title">工作统计</span></h2>
        <span id="stats_meta" class="sub"></span>
      </div>
      <div class="stats-controls">
        <div class="stats-control-group"><span class="stats-control-label">时间范围</span><div id="stats_tabs"></div></div>
        <div class="stats-control-group"><span class="stats-control-label">图表指标</span><div id="stats_metric"></div></div>
      </div>
    </div>
    <div id="stats_cards" class="grid"></div>
    <canvas id="stats_chart" class="stats-chart"></canvas>
    <div class="analysis-wrap">
      <div class="analysis-grid" id="analysis_cards"></div>
    </div>
    <div id="stats_tip"></div>
  </section>

  <section class="panel">
    <h2><span class="title">最近采样记录</span>
        <span class="section-note">多卡时：GPU 列 = 各卡利用率 · 显存 = 合计 · 温度 = 峰值</span></h2>
    <div class="scroller">
    <table>
      <thead><tr><th>时间</th><th>GPU%</th><th>显存 MB</th><th>温度°C</th><th>RAM%</th><th>CPU%</th></tr></thead>
      <tbody id="log_tbody"></tbody>
    </table>
    </div>
  </section>

  </div>
</div>

<!-- ============ Tab 2: 系统 ============ -->
<div id="tab_sys" class="hidden">
  <section class="panel">
    <h2><span class="title">主机信息</span></h2>
    <div class="hostrow">
      <div><div class="hlabel">主机名</div><div class="hval" id="host_name">—</div></div>
      <div><div class="hlabel">IP 地址</div><div class="hval mono" id="host_ip">—</div></div>
      <div><div class="hlabel">运行时长</div><div class="hval" id="host_uptime">—</div></div>
      <div><div class="hlabel">CPU 核心</div><div class="hval" id="host_cores">—</div></div>
      <div><div class="hlabel">负载 (1/5/15min)</div><div class="hval" id="host_load">—</div></div>
    </div>
  </section>

  <section class="grid">
    <div class="card" style="--c:var(--cpu)">
      <div class="label">CPU 占用</div>
      <div class="value" id="syscpu">—</div>
      <div class="extra">load <b id="sys_load">—</b> · <span id="cpu_n">—</span></div>
      <div class="bar"><i id="cpu_bar_sys"></i></div>
      <canvas class="spark" id="sp_syscpu"></canvas>
      <div class="corebar" id="corebar"></div>
    </div>
    <div class="card" style="--c:var(--ram)">
      <div class="label">内存 / Swap</div>
      <div class="value" id="sysmem">—</div>
      <div class="extra" id="mem_extra"></div>
      <div class="bar"><i id="mem_bar_sys"></i></div>
      <canvas class="spark" id="sp_sysmem"></canvas>
      <div class="extra">swap <span id="swapline">—</span></div>
    </div>
    <div class="card" style="--c:#5eead4">
      <div class="label">网络 ↓ / ↑</div>
      <div class="netrow" style="margin-top:6px">
        <span class="big">↓ <b id="rx">—</b></span>
        <span class="big">↑ <b id="tx">—</b></span>
      </div>
      <canvas class="spark" id="sp_net"></canvas>
      <div class="extra">累计 ↓<span id="rxt">—</span> · ↑<span id="txt">—</span></div>
    </div>
  </section>

  <section class="panel">
    <h2><span class="title">磁盘挂载点</span></h2>
    <div id="disks_box"><span class="dim">读取中…</span></div>
  </section>

  <section class="panel">
    <h2><span class="title">TOP 进程（按 CPU）</span></h2>
    <div class="scroller">
    <table class="stack">
      <thead><tr><th>PID</th><th>进程</th><th>CPU%</th><th>MEM%</th><th>内存</th></tr></thead>
      <tbody id="top_tbody"></tbody>
    </table>
    </div>
  </section>

  <div class="halfrow">
    <section class="panel hidden" id="coreuse_panel">
      <h2><span class="title">CPU 占用 · 每核</span><span id="coreuse_max" class="legend"></span></h2>
      <div class="chipgrid" id="coreuse_box"></div>
    </section>
    <section class="panel hidden" id="temps_panel">
      <h2><span class="title">温度 · 每核</span><span id="temps_max" class="legend"></span></h2>
      <div class="chipgrid" id="temps_box"></div>
    </section>
  </div>

  <section class="panel">
    <h2><span class="title">系统趋势（最近 30 分钟）</span><span id="sys_legend" class="legend"></span></h2>
    <canvas id="syschart"></canvas>
  </section>
</div>

<footer class="foot">统一监控面板 · 推理历史 30 分钟 · 长期趋势 3 年（30 天后按小时压缩） ·
数据源：NVIDIA GPU 采样 / llama.cpp、vLLM、fastllm 原生遥测 / 代理请求账本 / 系统实时指标</footer>

<script>
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
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = SERVER_VERSION

    def log_message(self, fmt, *args):
        pass  # 静默访问日志

    def _send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _authorized(self):
        if not PANEL_TOKEN:
            return True
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if q.get("token", [""])[0] == PANEL_TOKEN:
            return True
        return self.headers.get("Authorization", "") == "Bearer " + PANEL_TOKEN

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p in ("/", "/index.html"):
            self._send(200, PAGE, "text/html; charset=utf-8")
            return
        if not self._authorized():
            self._send(403, "forbidden", "text/plain")
            return
        if p == "/api/latest":
            with _snap_lock:
                body = dict(_current)
            body["inference_available"] = INFERENCE_AVAILABLE
            self._send(200, json.dumps(body, ensure_ascii=False),
                       "application/json; charset=utf-8")
        elif p == "/api/history":
            limit = 60
            try:
                limit = int(parse_qs(u.query).get("limit", ["60"])[0])
                limit = max(1, min(limit, MAX_HISTORY))
            except ValueError:
                pass
            with _history_lock:
                items = list(_history)[-limit:]
            # 历史列表去掉大字段，减小体积（前端 sparkline 只用数值字段）
            slim = []
            for s in items:
                d = dict(s)
                sy = dict(d.get("system") or {})
                sy.pop("top_procs", None)
                sy.pop("temps", None)
                d["system"] = sy
                slim.append(d)
            self._send(200, json.dumps(slim, ensure_ascii=False),
                       "application/json; charset=utf-8")
        elif p == "/api/stats":
            with _stats_lock:
                body = dict(_stats_cache)
            self._send(200, json.dumps(body, ensure_ascii=False),
                       "application/json; charset=utf-8")
        elif p == "/api/health":
            self._send(200, json.dumps({
                "ok": True,
                "version": SERVER_VERSION,
                "hostname": HOSTNAME,
                "uptime_s": int(time.time() - START_TIME),
                "samples": len(_history),
                "interval": SAMPLE_INTERVAL,
                "llm_url": LLM_URL,
                "llm_kind": LLM_KIND,
                "llm_proxy": {"enabled": _LLM_PROXY.get("enabled", False),
                              "port": _LLM_PROXY.get("port", 0),
                              "host": LLM_PROXY_HOST, "upstream": LLM_URL},
                "nvidia_smi_found": GPU_OK,
                "llama_reachable": LLM_OK,
                "gpu_available": GPU_OK,
                "llama_available": LLM_OK,
                "inference_available": bool(GPU_OK and LLM_OK),
                "inference_history": (os.path.getsize(STATS_LOG) > 0) if os.path.exists(STATS_LOG) else False,
                "psutil": psutil is not None,
            }, ensure_ascii=False), "application/json; charset=utf-8")
        else:
            self._send(404, "not found", "text/plain")


def main():
    global PORT, LLM_OK, INFERENCE_AVAILABLE
    if len(sys.argv) > 1:
        try:
            PORT = int(sys.argv[1])
        except ValueError:
            pass

    # ---- 自适应探测：nvidia-smi 在 PATH？llama-server 可达？ ----
    LLM_OK = _probe_llama()
    INFERENCE_AVAILABLE = GPU_OK or LLM_OK
    print("组件探测: nvidia-smi=%s  推理引擎(%s)=%s [kind=%s]  → 推理模块=%s"
          % (GPU_OK, LLM_URL, LLM_OK, LLM_KIND,
             "可用" if INFERENCE_AVAILABLE else "不可用"))

    threading.Thread(target=inference_loop_fast, daemon=True).start()
    threading.Thread(target=gpu_loop, daemon=True).start()
    threading.Thread(target=system_loop, daemon=True).start()
    threading.Thread(target=stats_loop, daemon=True).start()
    start_llm_proxy()

    def llama_reprobe():
        """每 30s 复测推理引擎（含类型识别）：停/启/换引擎后面板状态自动跟随"""
        global LLM_OK
        while True:
            time.sleep(30)
            try:
                LLM_OK = _probe_llama()
            except Exception:
                pass
    threading.Thread(target=llama_reprobe, daemon=True).start()
    print("统一监控面板已启动: http://127.0.0.1:%d  (局域网: http://<本机IP>:%d)"
          % (PORT, PORT))
    if CSV_INTERVAL <= 0:
        print("LLM: %s   快采样 %.1fs   历史 %d 条   CSV: 已关闭"
              % (LLM_URL, SAMPLE_INTERVAL, MAX_HISTORY))
    else:
        print("LLM: %s   快采样 %.1fs   历史 %d 条   CSV: %s (每 %gs 一行)"
              % (LLM_URL, SAMPLE_INTERVAL, MAX_HISTORY, CSV_LOG, CSV_INTERVAL))
    if PANEL_TOKEN:
        print("认证已启用 (PANEL_TOKEN)")
    try:
        server = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    except OSError as e:
        raise SystemExit("端口 %d 启动失败（可能被占用）: %s" % (PORT, e))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
