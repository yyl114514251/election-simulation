# -*- coding: utf-8 -*-
"""
server.py - 虚拟选举模拟器 后端服务
纯 Python 标准库实现（http.server + sqlite3），零第三方依赖。
启动：python server.py   （默认 http://127.0.0.1:8001）
"""
import os
import re
import io
import csv
import json
import random
import hashlib
import sqlite3
import threading
import datetime
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "election.db")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8001"))
MAX_BODY = 16 * 1024 * 1024  # 16MB

_write_lock = threading.Lock()
_rng = random.Random()

STATUS_LABELS = {
    "draft": "筹备中",
    "voting": "投票中",
    "closed": "已结束",
}

# 候选配色（canvas 图表用）
PALETTE = ["#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
           "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1"]


def utcnow():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------
def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS elections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            rule TEXT DEFAULT 'plurality',
            num_districts INTEGER DEFAULT 1,
            status TEXT DEFAULT 'draft',
            abstain_rate REAL DEFAULT 0.05,
            invalid_rate REAL DEFAULT 0.01,
            created_at TEXT, updated_at TEXT, closed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            election_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            party TEXT DEFAULT '',
            bio TEXT DEFAULT '',
            color TEXT DEFAULT '#3b82f6',
            order_no INTEGER DEFAULT 0,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS voters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            election_id INTEGER NOT NULL,
            district INTEGER DEFAULT 1,
            voter_no TEXT NOT NULL,
            has_voted INTEGER DEFAULT 0,
            voted_at TEXT,
            created_at TEXT,
            UNIQUE(election_id, voter_no)
        );
        CREATE TABLE IF NOT EXISTS votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            election_id INTEGER NOT NULL,
            voter_id INTEGER NOT NULL,
            candidate_id INTEGER,
            district INTEGER DEFAULT 1,
            is_valid INTEGER DEFAULT 1,
            fingerprint TEXT,
            created_at TEXT,
            UNIQUE(election_id, voter_id)
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, action TEXT, detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cand_elec ON candidates(election_id);
        CREATE INDEX IF NOT EXISTS idx_voter_elec ON voters(election_id);
        CREATE INDEX IF NOT EXISTS idx_votes_elec ON votes(election_id);
        CREATE INDEX IF NOT EXISTS idx_votes_cand ON votes(election_id, candidate_id);
        CREATE INDEX IF NOT EXISTS idx_votes_dist ON votes(election_id, district);
        """
    )
    conn.commit()
    conn.close()


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def log_audit(conn, action, detail):
    conn.execute("INSERT INTO audit_logs(ts,action,detail) VALUES(?,?,?)",
                 (utcnow(), action, detail))


# ---------------------------------------------------------------------------
# HTTP 工具
# ---------------------------------------------------------------------------
def send_json(handler, status, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        pass


def ok(handler, data=None):
    send_json(handler, 200, {"ok": True, "data": data})


def fail(handler, status, msg):
    send_json(handler, status, {"ok": False, "error": msg})


def read_json_body(handler):
    length = int(handler.headers.get("Content-Length", 0) or 0)
    if length <= 0:
        return {}
    if length > MAX_BODY:
        raise ValueError("请求体过大")
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    try:
        obj = json.loads(raw.decode("utf-8"))
    except Exception:
        raise ValueError("JSON 解析失败")
    return obj if isinstance(obj, dict) else {}


# ---------------------------------------------------------------------------
# 业务工具
# ---------------------------------------------------------------------------
def get_election(conn, eid):
    row = conn.execute("SELECT * FROM elections WHERE id=?", (eid,)).fetchone()
    return row


def get_candidates(conn, eid):
    return conn.execute(
        "SELECT * FROM candidates WHERE election_id=? ORDER BY order_no,id",
        (eid,)).fetchall()


def election_overview(conn, eid):
    """返回选举统计摘要。"""
    total_voters = conn.execute(
        "SELECT COUNT(*) c FROM voters WHERE election_id=?", (eid,)).fetchone()["c"]
    voted = conn.execute(
        "SELECT COUNT(*) c FROM voters WHERE election_id=? AND has_voted=1",
        (eid,)).fetchone()["c"]
    total_votes = conn.execute(
        "SELECT COUNT(*) c FROM votes WHERE election_id=?", (eid,)).fetchone()["c"]
    valid = conn.execute(
        "SELECT COUNT(*) c FROM votes WHERE election_id=? AND is_valid=1",
        (eid,)).fetchone()["c"]
    invalid = total_votes - valid
    cand_rows = get_candidates(conn, eid)
    tally = []
    for c in cand_rows:
        n = conn.execute(
            "SELECT COUNT(*) c FROM votes WHERE election_id=? AND candidate_id=? AND is_valid=1",
            (eid, c["id"])).fetchone()["c"]
        tally.append({"id": c["id"], "name": c["name"], "party": c["party"],
                      "color": c["color"], "votes": n})
    tally.sort(key=lambda x: -x["votes"])
    return {
        "total_voters": total_voters,
        "voted": voted,
        "turnout_rate": round(voted / total_voters, 4) if total_voters else 0,
        "total_votes": total_votes,
        "valid": valid,
        "invalid": invalid,
        "invalid_rate": round(invalid / total_votes, 4) if total_votes else 0,
        "tally": tally,
    }


def district_tally(conn, eid):
    """分选区计票：{district: [{candidate, votes}]}"""
    cands = get_candidates(conn, eid)
    rows = conn.execute(
        "SELECT district, candidate_id, COUNT(*) c FROM votes"
        " WHERE election_id=? AND is_valid=1 GROUP BY district, candidate_id",
        (eid,)).fetchall()
    by_dist = {}
    for r in rows:
        by_dist.setdefault(r["district"], {})[r["candidate_id"]] = r["c"]
    out = []
    districts = conn.execute(
        "SELECT DISTINCT district FROM voters WHERE election_id=? ORDER BY district",
        (eid,)).fetchall()
    for drow in districts:
        d = drow["district"]
        items = []
        for c in cands:
            items.append({"id": c["id"], "name": c["name"], "party": c["party"],
                          "color": c["color"], "votes": by_dist.get(d, {}).get(c["id"], 0)})
        items.sort(key=lambda x: -x["votes"])
        out.append({"district": d, "items": items})
    return out


def fingerprint(eid, voter_no, candidate_id, ts):
    raw = "%d|%s|%s|%s" % (eid, voter_no, candidate_id, ts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# API：选举
# ---------------------------------------------------------------------------
def api_list_elections(handler, conn):
    rows = conn.execute("SELECT * FROM elections ORDER BY id DESC").fetchall()
    items = []
    for r in rows:
        d = dict(r)
        ov = election_overview(conn, r["id"])
        d["overview"] = ov
        d["candidate_count"] = conn.execute(
            "SELECT COUNT(*) c FROM candidates WHERE election_id=?", (r["id"],)).fetchone()["c"]
        items.append(d)
    ok(handler, {"items": items})


def api_create_election(handler, conn, body):
    title = str(body.get("title", "")).strip()
    if not title:
        raise ValueError("请填写选举名称")
    if len(title) > 60:
        raise ValueError("选举名称过长")
    num_districts = max(1, min(50, int(body.get("num_districts", 1) or 1)))
    rule = str(body.get("rule", "plurality"))
    if rule not in ("plurality", "majority"):
        raise ValueError("不支持的选举规则")
    abstain = float(body.get("abstain_rate", 0.05) or 0)
    invalid = float(body.get("invalid_rate", 0.01) or 0)
    abstain = min(0.9, max(0.0, abstain))
    invalid = min(0.5, max(0.0, invalid))
    with _write_lock:
        cur = conn.execute(
            "INSERT INTO elections(title,description,rule,num_districts,status,"
            "abstain_rate,invalid_rate,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (title, str(body.get("description", "")), rule, num_districts, "draft",
             abstain, invalid, utcnow(), utcnow()))
        eid = cur.lastrowid
        conn.commit()
        log_audit(conn, "create_election", "创建选举: %s (id=%d)" % (title, eid))
        conn.commit()
    ok(handler, {"id": eid, "message": "选举已创建"})


def api_get_election(handler, conn, eid):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    d = dict(e)
    d["candidates"] = [dict(c) for c in get_candidates(conn, eid)]
    d["overview"] = election_overview(conn, eid)
    d["districts"] = district_tally(conn, eid)
    d["voter_count"] = conn.execute(
        "SELECT COUNT(*) c FROM voters WHERE election_id=?", (eid,)).fetchone()["c"]
    d["vote_count"] = conn.execute(
        "SELECT COUNT(*) c FROM votes WHERE election_id=?", (eid,)).fetchone()["c"]
    ok(handler, d)


def api_update_election(handler, conn, eid, body):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    if e["status"] != "draft":
        raise PermissionError("仅筹备中的选举可修改")
    title = str(body.get("title", e["title"])).strip()
    if not title:
        raise ValueError("选举名称不能为空")
    with _write_lock:
        conn.execute(
            "UPDATE elections SET title=?,description=?,num_districts=?,abstain_rate=?,"
            "invalid_rate=?,updated_at=? WHERE id=?",
            (title, str(body.get("description", e["description"])),
             max(1, min(50, int(body.get("num_districts", e["num_districts"]) or 1))),
             min(0.9, max(0.0, float(body.get("abstain_rate", e["abstain_rate"]) or 0))),
             min(0.5, max(0.0, float(body.get("invalid_rate", e["invalid_rate"]) or 0))),
             utcnow(), eid))
        conn.commit()
        log_audit(conn, "update_election", "更新选举 id=%d" % eid)
        conn.commit()
    ok(handler, {"message": "已保存"})


def api_start_election(handler, conn, eid):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    cands = get_candidates(conn, eid)
    if not cands:
        raise ValueError("至少需要 2 名候选人才能开始投票")
    with _write_lock:
        conn.execute("UPDATE elections SET status='voting',updated_at=? WHERE id=?",
                     (utcnow(), eid))
        conn.commit()
        log_audit(conn, "start_election", "开始投票 id=%d" % eid)
        conn.commit()
    ok(handler, {"message": "投票已开始"})


def api_close_election(handler, conn, eid):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    with _write_lock:
        conn.execute("UPDATE elections SET status='closed',closed_at=?,updated_at=? WHERE id=?",
                     (utcnow(), utcnow(), eid))
        conn.commit()
        log_audit(conn, "close_election", "结束选举 id=%d" % eid)
        conn.commit()
    ok(handler, {"message": "选举已结束"})


def api_delete_election(handler, conn, eid):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    with _write_lock:
        for t in ("votes", "voters", "candidates"):
            conn.execute("DELETE FROM %s WHERE election_id=?" % t, (eid,))
        conn.execute("DELETE FROM elections WHERE id=?", (eid,))
        conn.commit()
        log_audit(conn, "delete_election", "删除选举 id=%d" % eid)
        conn.commit()
    ok(handler, {"message": "已删除"})


# ---------------------------------------------------------------------------
# API：候选人
# ---------------------------------------------------------------------------
def api_add_candidate(handler, conn, eid, body):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    if e["status"] != "draft":
        raise PermissionError("投票开始后不能添加候选人")
    name = str(body.get("name", "")).strip()
    if not name:
        raise ValueError("候选人姓名不能为空")
    count = conn.execute("SELECT COUNT(*) c FROM candidates WHERE election_id=?",
                         (eid,)).fetchone()["c"]
    if count >= 10:
        raise ValueError("每场选举最多 10 名候选人")
    color = str(body.get("color", "")).strip() or PALETTE[count % len(PALETTE)]
    with _write_lock:
        cur = conn.execute(
            "INSERT INTO candidates(election_id,name,party,bio,color,order_no,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (eid, name, str(body.get("party", "")).strip(),
             str(body.get("bio", "")).strip(), color, count, utcnow()))
        cid = cur.lastrowid
        conn.commit()
        log_audit(conn, "add_candidate", "选举 %d 添加候选人 %s" % (eid, name))
        conn.commit()
    ok(handler, {"id": cid, "message": "已添加候选人"})


def api_delete_candidate(handler, conn, cid):
    c = conn.execute("SELECT * FROM candidates WHERE id=?", (cid,)).fetchone()
    if c is None:
        raise LookupError("候选人不存在")
    e = get_election(conn, c["election_id"])
    if e["status"] != "draft":
        raise PermissionError("投票开始后不能删除候选人")
    with _write_lock:
        conn.execute("DELETE FROM candidates WHERE id=?", (cid,))
        conn.commit()
        log_audit(conn, "delete_candidate", "删除候选人 id=%d" % cid)
        conn.commit()
    ok(handler, {"message": "已删除"})


# ---------------------------------------------------------------------------
# API：选民
# ---------------------------------------------------------------------------
def api_generate_voters(handler, conn, eid, body):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    if e["status"] != "draft":
        raise PermissionError("投票开始后不能生成选民")
    has = conn.execute("SELECT COUNT(*) c FROM voters WHERE election_id=?",
                       (eid,)).fetchone()["c"]
    if has > 0:
        raise ValueError("该选举已有选民，请先清空再生成")
    count = int(body.get("count", 1000) or 1000)
    if count < 10 or count > 1000000:
        raise ValueError("选民数量须在 10 ~ 1000000 之间")
    districts = max(1, min(50, int(body.get("districts", e["num_districts"]) or 1)))
    # 若选举未显式配置选区数则同步
    if e["num_districts"] != districts:
        conn.execute("UPDATE elections SET num_districts=? WHERE id=?",
                     (districts, eid))
    voters = []
    for i in range(1, count + 1):
        voters.append((eid, (i % districts) + 1, "V%06d" % i, utcnow()))
    with _write_lock:
        conn.executemany(
            "INSERT INTO voters(election_id,district,voter_no,created_at)"
            " VALUES(?,?,?,?)", voters)
        conn.commit()
        log_audit(conn, "generate_voters", "选举 %d 生成选民 %d 人（%d 个选区）"
                  % (eid, count, districts))
        conn.commit()
    ok(handler, {"message": "已生成 %d 名选民（%d 个选区）" % (count, districts),
                 "count": count})


def api_clear_voters(handler, conn, eid):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    if e["status"] != "draft":
        raise PermissionError("投票开始后不能清空选民")
    with _write_lock:
        conn.execute("DELETE FROM votes WHERE election_id=?", (eid,))
        conn.execute("DELETE FROM voters WHERE election_id=?", (eid,))
        conn.commit()
        log_audit(conn, "clear_voters", "清空选举 %d 选民与投票" % eid)
        conn.commit()
    ok(handler, {"message": "已清空"})


def api_list_voters(handler, conn, eid, query=None):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    page = max(1, int((query or {}).get("page", 1) or 1))
    size = min(200, max(10, int((query or {}).get("size", 50) or 50)))
    q = str((query or {}).get("q", "")).strip()
    where = "election_id=?"
    args = [eid]
    if q:
        where += " AND (voter_no LIKE ? OR CAST(district AS TEXT) LIKE ?)"
        args += ["%%%s%%" % q, "%%%s%%" % q]
    total = conn.execute("SELECT COUNT(*) c FROM voters WHERE " + where,
                         args).fetchone()["c"]
    rows = conn.execute(
        "SELECT v.*, (SELECT candidate_id FROM votes WHERE election_id=v.election_id"
        " AND voter_id=v.id) AS voted_candidate_id"
        " FROM voters v WHERE " + where + " ORDER BY v.id LIMIT ? OFFSET ?",
        args + [size, (page - 1) * size]).fetchall()
    cand_map = {c["id"]: c["name"] for c in get_candidates(conn, eid)}
    items = []
    for r in rows:
        d = dict(r)
        cid = d.pop("voted_candidate_id", None)
        d["voted_name"] = cand_map.get(cid, "") if cid else ""
        items.append(d)
    ok(handler, {"items": items, "total": total, "page": page,
                 "pages": max(1, -(-total // size))})


# ---------------------------------------------------------------------------
# API：模拟投票（核心，批量高性能）
# ---------------------------------------------------------------------------
def _sample_choice(rng, weights):
    """按权重比例采样。weights: [(key, weight)]，weight>0"""
    total = sum(w for _, w in weights)
    if total <= 0:
        return weights[0][0] if weights else None
    r = rng.uniform(0, total)
    acc = 0.0
    for k, w in weights:
        acc += w
        if r <= acc:
            return k
    return weights[-1][0]


def api_simulate(handler, conn, eid, body):
    """分批模拟投票。返回 {done, batch_inserted, total_voters, voted, tally}。
    行为模型：weights={cid: weight} 全局偏好；district_biases={d:{cid:delta}} 选区偏移；
    abstain_rate 弃权率；invalid_rate 无效票率；batch 每批票数。
    """
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    if e["status"] != "voting":
        raise PermissionError("请先开始投票再模拟")
    cands = get_candidates(conn, eid)
    if not cands:
        raise ValueError("没有候选人")
    batch = max(200, min(20000, int(body.get("batch", 5000) or 5000)))

    # 剩余未投票选民
    unvoted = conn.execute(
        "SELECT id, district, voter_no FROM voters WHERE election_id=? AND has_voted=0"
        " ORDER BY id LIMIT ?", (eid, batch)).fetchall()
    if not unvoted:
        ok(handler, {"done": True, "batch_inserted": 0, "total_voters": 0,
                     "voted": 0, "message": "所有选民均已投票"})
        return

    # 解析行为参数
    weights_raw = body.get("weights") or {}
    weights = {}
    for c in cands:
        w = float(str(weights_raw.get(str(c["id"]), "")).strip() or 0)
        weights[c["id"]] = max(0.0, w)
    if not any(weights.values()):
        # 默认均衡：每人权重 1
        for c in cands:
            weights[c["id"]] = 1.0
    biases_raw = body.get("district_biases") or {}
    biases = {}
    for d, m in biases_raw.items():
        try:
            dint = int(d)
        except Exception:
            continue
        if isinstance(m, dict):
            biases[dint] = {int(k): float(v) for k, v in m.items()}
    abstain = min(0.9, max(0.0, float(body.get("abstain_rate", e["abstain_rate"]) or 0)))
    invalid = min(0.5, max(0.0, float(body.get("invalid_rate", e["invalid_rate"]) or 0)))

    rng = random.Random(body.get("seed") or None)
    ts = utcnow()
    vote_rows = []
    voted_ids = []
    for v in unvoted:
        # 弃权
        if rng.random() < abstain:
            continue
        # 无效票
        if rng.random() < invalid:
            fp = fingerprint(eid, v["voter_no"], "INVALID", ts)
            vote_rows.append((eid, v["id"], None, v["district"], 0, fp, ts))
            voted_ids.append(v["id"])
            continue
        # 有效票：全局权重 + 选区偏移 + 噪声
        w = {}
        for cid, base in weights.items():
            b = biases.get(v["district"], {}).get(cid, 0.0)
            noise = rng.uniform(0.8, 1.2)
            w[cid] = max(0.0, base + b) * noise
        cid = _sample_choice(rng, list(w.items()))
        fp = fingerprint(eid, v["voter_no"], cid, ts)
        vote_rows.append((eid, v["id"], cid, v["district"], 1, fp, ts))
        voted_ids.append(v["id"])

    with _write_lock:
        conn.executemany(
            "INSERT INTO votes(election_id,voter_id,candidate_id,district,is_valid,"
            "fingerprint,created_at) VALUES(?,?,?,?,?,?,?)", vote_rows)
        conn.executemany(
            "UPDATE voters SET has_voted=1,voted_at=? WHERE id=?", 
            [(ts, vid) for vid in voted_ids])
        conn.commit()
        log_audit(conn, "simulate_votes", "选举 %d 模拟投票一批 %d 票"
                  % (eid, len(vote_rows)))
        conn.commit()

    remaining = conn.execute(
        "SELECT COUNT(*) c FROM voters WHERE election_id=? AND has_voted=0",
        (eid,)).fetchone()["c"]
    done = remaining == 0
    ok(handler, {
        "done": done,
        "batch_inserted": len(vote_rows),
        "remaining": remaining,
        "overview": election_overview(conn, eid),
        "message": "本批投出 %d 票，剩余 %d 人未投票" % (len(vote_rows), remaining)
        if not done else "全部选民投票完成",
    })


def api_reset_votes(handler, conn, eid):
    """清空投票记录并重置选民状态（仅投票中可）。"""
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    if e["status"] != "voting":
        raise PermissionError("仅投票中可重置票箱")
    with _write_lock:
        conn.execute("DELETE FROM votes WHERE election_id=?", (eid,))
        conn.execute("UPDATE voters SET has_voted=0,voted_at=NULL WHERE election_id=?",
                     (eid,))
        conn.commit()
        log_audit(conn, "reset_votes", "重置选举 %d 票箱" % eid)
        conn.commit()
    ok(handler, {"message": "票箱已重置"})


# ---------------------------------------------------------------------------
# API：计票 / 审计 / 导出
# ---------------------------------------------------------------------------
def api_tally(handler, conn, eid, query=None):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    ov = election_overview(conn, eid)
    dist = district_tally(conn, eid)
    ok(handler, {"overview": ov, "districts": dist})


def api_audit(handler, conn, eid, query=None):
    rows = conn.execute(
        "SELECT * FROM audit_logs WHERE detail LIKE ? ORDER BY id DESC LIMIT 200",
        ("%%选举 %d%%" % eid,)).fetchall()
    items = [dict(r) for r in rows]
    if not items:
        # 退回全部日志（含创建）
        rows = conn.execute("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200").fetchall()
        items = [dict(r) for r in rows]
    ok(handler, {"items": items})


def _send_csv(handler, filename, headers, rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(headers)
    for r in rows:
        w.writerow(["" if x is None else x for x in r])
    data = ("\ufeff" + buf.getvalue()).encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "text/csv; charset=utf-8")
    handler.send_header("Content-Disposition",
                        "attachment; filename*=UTF-8''" + urllib.parse.quote(filename))
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    try:
        handler.wfile.write(data)
    except (BrokenPipeError, ConnectionResetError):
        pass


def api_export(handler, conn, eid, kind):
    e = get_election(conn, eid)
    if e is None:
        raise LookupError("选举不存在")
    cand_map = {c["id"]: c["name"] for c in get_candidates(conn, eid)}
    if kind == "votes":
        rows = conn.execute(
            "SELECT v.id, v.voter_no, v.district, v.created_at, v.is_valid,"
            " v.candidate_id, v.fingerprint FROM voters v"
            " JOIN votes vo ON vo.voter_id=v.id"
            " WHERE v.election_id=? ORDER BY v.id", (eid,)).fetchall()
        _send_csv(handler, "election%d_votes.csv" % eid,
                  ["vote_id", "voter_no", "district", "voted_at", "valid",
                   "candidate", "fingerprint"],
                  [[r["id"], r["voter_no"], r["district"], r["created_at"],
                    r["is_valid"], cand_map.get(r["candidate_id"], ""),
                    r["fingerprint"]] for r in rows])
    elif kind == "voters":
        rows = conn.execute(
            "SELECT voter_no, district, has_voted FROM voters WHERE election_id=?"
            " ORDER BY id", (eid,)).fetchall()
        _send_csv(handler, "election%d_voters.csv" % eid,
                  ["voter_no", "district", "has_voted"],
                  [[r["voter_no"], r["district"], r["has_voted"]] for r in rows])
    else:
        ov = election_overview(conn, eid)
        rows = [[c["id"], c["name"], c["party"], c["votes"]] for c in ov["tally"]]
        rows.append(["", "弃权", "", ov["total_voters"] - ov["voted"]])
        rows.append(["", "无效票", "", ov["invalid"]])
        _send_csv(handler, "election%d_result.csv" % eid,
                  ["candidate_id", "candidate", "party", "votes"], rows)


# ---------------------------------------------------------------------------
# API：演示数据（虚构）
# ---------------------------------------------------------------------------
def api_demo(handler, conn):
    """一键创建虚构演示选举并生成数据，便于立即体验。"""
    with _write_lock:
        cur = conn.execute(
            "INSERT INTO elections(title,description,rule,num_districts,status,"
            "abstain_rate,invalid_rate,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            ("2026 校园模拟选举（演示）", "系统自动生成的虚构演示数据，候选人与选民均为虚拟。",
             "plurality", 5, "voting", 0.04, 0.015, utcnow(), utcnow()))
        eid = cur.lastrowid
        demo_cands = [
            ("林晓宇", "科技创新联盟", "推动数字化校园建设", "#3b82f6"),
            ("周子涵", "绿色未来社", "倡导低碳校园生活", "#22c55e"),
            ("陈思远", "人文关怀派", "关注师生权益保障", "#f59e0b"),
            ("赵雨桐", "文体活力派", "丰富校园文体活动", "#ec4899"),
        ]
        for i, (n, p, b, c) in enumerate(demo_cands):
            conn.execute(
                "INSERT INTO candidates(election_id,name,party,bio,color,order_no,created_at)"
                " VALUES(?,?,?,?,?,?,?)", (eid, n, p, b, c, i, utcnow()))
        voters = [(eid, (i % 5) + 1, "V%06d" % i, utcnow()) for i in range(1, 20001)]
        conn.executemany(
            "INSERT INTO voters(election_id,district,voter_no,created_at)"
            " VALUES(?,?,?,?)", voters)
        # 预先模拟 2 万票：权重 [5,3,2,1] + 选区偏移
        cands = get_candidates(conn, eid)
        ids = [c["id"] for c in cands]
        base = {ids[0]: 5.0, ids[1]: 3.0, ids[2]: 2.0, ids[3]: 1.0}
        biases = {}
        for d in range(1, 6):
            biases[d] = {ids[0]: 0.6 - 0.15 * d, ids[3]: 0.2 * d}
        rng = random.Random(2026)
        ts = utcnow()
        unvoted = conn.execute(
            "SELECT id, district, voter_no FROM voters WHERE election_id=?"
            " ORDER BY id", (eid,)).fetchall()
        rows = []
        for v in unvoted:
            if rng.random() < 0.04:
                continue
            if rng.random() < 0.015:
                rows.append((eid, v["id"], None, v["district"], 0,
                             fingerprint(eid, v["voter_no"], "INVALID", ts), ts))
                continue
            w = {}
            for cid, b in base.items():
                w[cid] = max(0.0, b + biases.get(v["district"], {}).get(cid, 0.0)) \
                    * rng.uniform(0.8, 1.2)
            cid = _sample_choice(rng, list(w.items()))
            rows.append((eid, v["id"], cid, v["district"], 1,
                         fingerprint(eid, v["voter_no"], cid, ts), ts))
        conn.executemany(
            "INSERT INTO votes(election_id,voter_id,candidate_id,district,is_valid,"
            "fingerprint,created_at) VALUES(?,?,?,?,?,?,?)", rows)
        conn.executemany("UPDATE voters SET has_voted=1,voted_at=? WHERE id=?",
                         [(ts, v["id"]) for v in unvoted])
        conn.commit()
        log_audit(conn, "create_demo", "创建演示选举 id=%d（2 万虚拟选民）" % eid)
        conn.commit()
    ok(handler, {"id": eid, "message": "演示选举已创建（含 2 万虚拟选民与已完成投票）"})


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "ElectionSim/1.0"

    def log_message(self, fmt, *args):
        pass

    # ---- 工具 ----
    def _send_static(self, path):
        if path == "/":
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(os.path.normpath(STATIC_DIR)):
            return self._json(403, "forbidden")
        if not os.path.isfile(full):
            return self._json(404, "not found")
        ctype = mimetypes_guess(full)
        data = open(full, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status, obj):
        send_json(self, status, obj)

    def _err(self, exc):
        if isinstance(exc, PermissionError):
            self._json(403, str(exc))
        elif isinstance(exc, (LookupError, ValueError)):
            self._json(400, str(exc))
        else:
            self._json(500, "服务器错误: %s" % exc)

    # ---- 请求分发 ----
    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method):
        conn = None
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            query = dict(urllib.parse.parse_qsl(parsed.query))
            if not path.startswith("/api/"):
                if method == "GET":
                    return self._send_static(path)
                return self._json(404, "not found")
            conn = get_conn()
            parts = [p for p in path.split("/") if p]
            # parts: ["api", ...]
            self._dispatch(conn, method, parts, query)
        except Exception as exc:
            self._err(exc)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def _dispatch(self, conn, method, parts, query):
        # /api/health
        if parts == ["api", "health"]:
            return ok(self, {"status": "up"})
        # /api/demo
        if parts == ["api", "demo"] and method == "POST":
            return api_demo(self, conn)
        # /api/elections
        if parts == ["api", "elections"]:
            if method == "GET":
                return api_list_elections(self, conn)
            if method == "POST":
                return api_create_election(self, conn, read_json_body(self))
            return self._json(405, "method not allowed")
        # /api/elections/{id}
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "elections":
            eid = self._pid(parts[2])
            if method == "GET":
                return api_get_election(self, conn, eid)
            if method == "PUT":
                return api_update_election(self, conn, eid, read_json_body(self))
            if method == "DELETE":
                return api_delete_election(self, conn, eid)
            return self._json(405, "method not allowed")
        # /api/elections/{id}/{action}
        if len(parts) == 4 and parts[0] == "api" and parts[1] == "elections":
            eid = self._pid(parts[2])
            act = parts[3]
            if method == "POST":
                if act == "start":
                    return api_start_election(self, conn, eid)
                if act == "close":
                    return api_close_election(self, conn, eid)
                if act == "voters":
                    return api_generate_voters(self, conn, eid, read_json_body(self))
                if act == "clear-voters":
                    return api_clear_voters(self, conn, eid)
                if act == "simulate":
                    return api_simulate(self, conn, eid, read_json_body(self))
                if act == "reset-votes":
                    return api_reset_votes(self, conn, eid)
                if act == "candidates":
                    return api_add_candidate(self, conn, eid, read_json_body(self))
                if act == "tally":
                    return api_tally(self, conn, eid, query)
                if act == "audit":
                    return api_audit(self, conn, eid, query)
            if method == "GET":
                if act == "voters":
                    return api_list_voters(self, conn, eid, query)
                if act == "tally":
                    return api_tally(self, conn, eid, query)
                if act == "audit":
                    return api_audit(self, conn, eid, query)
                if act == "export":
                    kind = query.get("kind", "result")
                    return api_export(self, conn, eid, kind)
            return self._json(405, "method not allowed")
        # /api/candidates/{cid}
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "candidates":
            cid = self._pid(parts[2])
            if method == "DELETE":
                return api_delete_candidate(self, conn, cid)
        return self._json(404, "not found")

    def _pid(self, s):
        try:
            return int(s)
        except ValueError:
            raise LookupError("无效的 ID: %s" % s)


def mimetypes_guess(path):
    ext = os.path.splitext(path)[1].lower()
    return {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
    }.get(ext, "application/octet-stream")


def auto_open_browser():
    if os.environ.get("ELECTION_NO_BROWSER") == "1":
        return
    import webbrowser
    import time

    def _open():
        time.sleep(1.2)
        try:
            webbrowser.open("http://127.0.0.1:%d" % PORT)
        except Exception:
            pass

    threading.Thread(target=_open, daemon=True).start()


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("=" * 56)
    print("  虚拟选举模拟器 已启动")
    print("  本机访问:  http://127.0.0.1:%d" % PORT)
    print("  局域网访问: http://<本机IP>:%d" % PORT)
    print("  按 Ctrl+C 停止服务")
    print("=" * 56)
    auto_open_browser()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
        server.server_close()


if __name__ == "__main__":
    main()
