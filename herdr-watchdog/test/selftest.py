#!/usr/bin/env python3
"""herdr-watchdog self-test (stage 2):

  A. flag tool: write -> read -> repeat (no-op) -> over-long reason truncated -> history capped at 20
  B. fake dry-run scenarios >= 5: normal pair / flag=true / both idle / reviewer stuck / unreadable label
     + worker stuck / missing path / multiple workers
  C. stage 3: real send / real interrupt (through fake herdr) + daemon + rotation + lock
  D. message dynamic parts: degenerate paths without age (calling the functions directly)

Message assertions check the dynamic parts (minutes / worker names / branch words), not just
the prefix, and verify that "the fake herdr received exactly the text printed to the console".

Uses a fake herdr (test/fake-herdr); never touches real panes. Every dry-run scenario also
asserts that no write call was made.
Run: python3 test/selftest.py
"""
import importlib.machinery
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True      # section D imports herdr-watchdog; do not leave __pycache__ in the repo

HERE = os.path.dirname(os.path.abspath(__file__))
WD = os.path.dirname(HERE)
HB = os.path.join(WD, "herdr-watchdog")
FAKE = os.path.join(HERE, "fake-herdr")

fails = []


def check(name, cond, extra=""):
    print("%s  %s%s" % ("PASS" if cond else "FAIL", name,
                        ("   <- " + extra.replace("\n", " | ")) if (not cond and extra) else ""))
    if not cond:
        fails.append(name)


def run(args, env=None):
    e = dict(os.environ)
    e.update(env or {})
    return subprocess.run([sys.executable, HB] + args, capture_output=True, text=True, env=e)


def load(p):
    with open(p) as f:
        return json.load(f)


# ============================================================ A. flag tool

print("\n===== A. flag tool (set / show / no-op / truncation / history cap) =====")
tmp = tempfile.mkdtemp(prefix="hb-selfA-")
FLAG = os.path.join(tmp, "selftest__wE:tX.json")
env = {"HB_DIR": tmp, "HERDR_SESSION": "selftest", "HERDR_TAB_ID": "wE:tX", "HERDR_PANE_ID": "wE:pV"}


def sh(args):
    p = run(args, env)
    print("$ herdr-watchdog %s\n%s" % (" ".join(args), (p.stdout + p.stderr).rstrip()))
    return p


p = sh(["set", "--action", "block", "--reason", "long task"])
check("A1 first block: exit 0 + file written", p.returncode == 0 and os.path.exists(FLAG),
      p.stdout + p.stderr)
d1 = load(FLAG)
check("A2 current=true / reason / timestamp written by the program",
      d1["current"] is True and d1["current_reason"] == "long task" and d1["current_since"])
check("A3 history[0] from=false to=true", d1["history"][0]["from"] is False
      and d1["history"][0]["to"] is True)
check("A4 by = HERDR_PANE_ID (no extra arg)", d1["history"][0]["by"] == "wE:pV")

p = sh(["set", "--action", "block", "--reason", "another sentence should not be written"])
d2 = load(FLAG)
check("A5 repeated block = no-op (one line only)",
      "already true" in p.stdout and "no change recorded" in p.stdout, p.stdout)
check("A6 no-op did not touch the file (history / since unchanged)",
      d2["history"] == d1["history"] and d2["current_since"] == d1["current_since"])

p = sh(["show"])
check("A7 show prints the current value + reason", "current: true" in p.stdout and "long task" in p.stdout, p.stdout)

p = sh(["get"])
check("A7b get prints exactly one line: true (footer reads it)", p.stdout.strip() == "true", p.stdout)

p = sh(["set", "--action", "unblock", "--reason", "back to work"])
d3 = load(FLAG)
check("A8 unblock = change (from=true to=false)", p.returncode == 0 and d3["current"] is False
      and d3["history"][-1]["from"] is True and d3["history"][-1]["to"] is False)

p = sh(["get"])
check("A8b get = false after unblock", p.stdout.strip() == "false", p.stdout)

# Regression: a 45-character mixed original (used to be blocked by a maxLength=40 schema)
INCIDENT = "migration+review done, awaiting approval now."
check("A9 original incident text is 45 chars (matches the report)", len(INCIDENT) == 45, "len=%d" % len(INCIDENT))
p = sh(["set", "--action", "block", "--reason", INCIDENT])
d4 = load(FLAG)
check("A9b 45 chars is no longer rejected (exit 0 + flag written + not truncated)",
      p.returncode == 0 and d4["current"] is True and d4["current_reason"] == INCIDENT
      and d4["history"][-1]["reason"] == INCIDENT,
      "exit=%d current=%s reason=%r" % (p.returncode, d4["current"], d4.get("current_reason")))

run(["set", "--action", "unblock", "--reason", "back to work 2"], env)   # flip back to false so the next write is real
p = sh(["set", "--action", "block", "--reason", "x" * 121])
d5 = load(FLAG)
check("A10 121 chars -> exit 0 (no error, not rejected)", p.returncode == 0, "exit=%d %s" % (p.returncode, p.stdout))
check("A10b flag written, reason is exactly 120 chars + …",
      d5["current"] is True and d5["current_reason"] == "x" * 120 + "…"
      and len(d5["current_reason"]) == 121,
      "len=%d %r" % (len(d5.get("current_reason") or ""), (d5.get("current_reason") or "")[-4:]))
check("A10c history also stores the truncated value", d5["history"][-1]["reason"] == "x" * 120 + "…")
check("A10d output mentions truncation", "truncated" in p.stdout and "keep it short" in p.stdout, p.stdout)
check("A10e no rejection wording", "rejected" not in p.stdout, p.stdout)

p = sh(["set", "--action", "block", "--reason", "   "])
check("A10f empty reason is still rejected (exit 2 + message)",
      p.returncode == 2 and "must not be empty" in p.stdout, "exit=%d %s" % (p.returncode, p.stdout))
check("A10g file unchanged after rejection", load(FLAG)["current_reason"] == "x" * 120 + "…")

# Keep these two numbers in sync: hb_block.ts maxLength is the loose gate and must be >= CLI REASON_MAX.
TS_LIMIT = re.search(r"maxLength:\s*(\d+)", open(os.path.join(WD, "hb_block.ts")).read())
CLI_LIMIT = re.search(r"REASON_MAX\s*=\s*(\d+)", open(HB).read())
ts_n = int(TS_LIMIT.group(1)) if TS_LIMIT else None
cli_n = int(CLI_LIMIT.group(1)) if CLI_LIMIT else None
check("A12 schema maxLength >= CLI REASON_MAX (changing one and forgetting the other fails)",
      ts_n is not None and cli_n is not None and ts_n >= cli_n,
      "hb_block.ts maxLength=%s, herdr-watchdog REASON_MAX=%s" % (ts_n, cli_n))

for i in range(25):
    run(["set", "--action", "block", "--reason", "t%d" % i], env)
    run(["set", "--action", "unblock", "--reason", "t%d" % i], env)
d5 = load(FLAG)
check("A11 history capped at 20 (after 50 changes)", len(d5["history"]) == 20,
      "len=%d" % len(d5["history"]))

# ============================================================ B. dry-run scenarios

print("\n===== B. dry-run scenarios (fake herdr, no real panes) =====")


def sess(d, name, age_sec):
    p = os.path.join(d, name)
    with open(p, "w") as f:
        f.write("{}\n")
    t = time.time() - age_sec
    os.utime(p, (t, t))
    return p


def agent(pid, tab, status, path=None, ws="wE"):
    a = {"pane_id": pid, "tab_id": tab, "workspace_id": ws, "agent_status": status}
    a["agent_session"] = ({"kind": "path", "value": path} if path
                          else {"kind": "id", "value": "session-id-only"})
    return a


def pane(pid, ws, label):
    return {"pane_id": pid, "workspace_id": ws, "label": label}


def dryrun(title, agents, panes, flag=None, expect=(), expect_warn=(), expect_absent=()):
    d = tempfile.mkdtemp(prefix="hb-selfB-")
    scen = os.path.join(d, "scen.json")
    with open(scen, "w") as f:
        json.dump({"agents": agents, "panes": panes}, f)
    log = os.path.join(d, "mutations.log")
    if flag is not None:
        with open(os.path.join(d, "selftest__%s.json" % flag["tab"]), "w") as f:
            json.dump(flag, f, ensure_ascii=False)
    p = run(["run", "--dry-run", "--herdr-bin", FAKE],
            {"HB_FAKE_SCENARIO": scen, "HB_FAKE_LOG": log, "HB_DIR": d, "HERDR_SESSION": "selftest"})
    print("\n--- %s ---" % title)
    print("$ HB_FAKE_SCENARIO=scen.json herdr-watchdog run --dry-run --herdr-bin test/fake-herdr")
    print(p.stdout.rstrip())
    touched = os.path.exists(log) and os.path.getsize(log) > 0
    check("[%s] dry-run did not act (fake herdr received no writes)" % title, not touched,
          open(log).read() if os.path.exists(log) else "")
    check("[%s] dry-run did not write the snapshot (read by the top view)" % title,
          not os.path.exists(os.path.join(d, "last-pass.json")), str(os.listdir(d)))
    for frag in expect:
        check("[%s] output contains %r" % (title, frag), frag in p.stdout, p.stdout)
    for frag in expect_warn:
        check("[%s] WARN contains %r" % (title, frag), "WARN" in p.stdout and frag in p.stdout, p.stdout)
    for frag in expect_absent:
        check("[%s] should not contain %r" % (title, frag), frag not in p.stdout, p.stdout)


d = tempfile.mkdtemp(prefix="hb-selfB-files-")
fresh = sess(d, "fresh-worker.jsonl", 20)
# 23*60+5: the minute assertion lands on 23, with 55s until the next minute (stable across a run)
stale = sess(d, "stale.jsonl", 23 * 60 + 5)

# 1 Normal pair: worker is working and has just produced output.
dryrun("1 normal pair (worker working and fresh)",
       [agent("wE:pV", "wE:t1", "idle", fresh), agent("wE:p1", "wE:t1", "working", fresh)],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")],
       expect=["flag: no file (treating as false)", "it is really working (return)", "action: none"])

# 2 flag=true: stop on reading the flag.
dryrun("2 flag=true (reviewer declared block)",
       [agent("wE:pV", "wE:t1", "idle", fresh), agent("wE:p1", "wE:t1", "working", stale)],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")],
       flag={"session": "selftest", "tab": "wE:t1", "reviewer_pane": "wE:pV", "current": True,
             "current_since": "2026-10-13T15:36:31", "current_reason": "long task", "history": []},
       expect=["flag: current=true", "judge: flag=true -> do not disturb", "action: none"])

# 3 Both idle -> message B.
dryrun("3 neither side working (-> message B)",
       [agent("wE:pV", "wE:t1", "idle", stale), agent("wE:p1", "wE:t1", "idle", stale)],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")],
       expect=["judge: no pane is working -> message B", "action: send message B -> wE:pV", "--- message B ---",
               "[heartbeat] Neither you nor the worker is working.",
               'Finished this round? hb_block(action=block, reason="done")',
               "Waiting for a human decision? Also block (say what you wait for), report to master",
               "Still have work? Do it; read the worker with last_answer",
               "I will ask again unless you block."])

# 3c Both panes have no age (kind=id) -> message unchanged, panes skipped with WARN.
dryrun("3c neither side working and no age available (-> still message B)",
       [agent("wE:pV", "wE:t1", "idle"), agent("wE:p1", "wE:t1", "idle")],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")],
       expect=["[heartbeat] Neither you nor the worker is working."],
       expect_warn=["has no session file path"])

# 4 Reviewer itself working for 23 minutes -> interrupt + A1.
dryrun("4 reviewer working with no output for 23 minutes (-> esc + A1)",
       [agent("wE:pV", "wE:t1", "working", stale), agent("wE:p1", "wE:t1", "idle", fresh)],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")],
       expect=["reviewer is working with no output for 23m", "action: send-keys wE:pV esc, then message A1",
               "--- message A1 ---",
               "[heartbeat] Your command produced no output, so I interrupted it",
               'Keep going. If a long task was interrupted by mistake, call hb_block(action=block, reason="long task")'],
       expect_absent=["action: send message B"])

# 5 Unreadable label -> WARN + no heartbeat.
dryrun("5 cannot identify a pair (no worker/reviewer label)",
       [agent("wE:pN", "wE:t9", "working", stale), agent("wE:pK", "wE:t9", "idle", fresh)],
       [pane("wE:pN", "wE", "master"), pane("wE:pK", "wE", "")],
       expect=["WARN", "wE:t9 cannot identify a pair", "no identifiable pairs"],
       expect_absent=["action:"])

# 6 Worker stuck + reviewer idle -> A2.
dryrun("6 worker working with no output for 15 minutes, reviewer idle (-> A2)",
       [agent("wE:pV", "wE:t1", "idle", fresh), agent("wE:p1", "wE:t1", "working", sess(d, "w15.jsonl", 15 * 60 + 5))],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")],
       expect=["judge: worker wE:p1 stuck (15m with no output), reviewer not working -> A2",
               "action: send message A2 -> wE:pV", "--- message A2 ---",
               "[heartbeat] worker wE:p1 has produced no output (state is still working).",
               "Long task (e2e etc.)? Block on behalf of the pair",
               "Really stuck? Go to that pane and handle it (send-keys esc / re-dispatch)."])

# 11 Two workers stuck -> both pane ids in A2.
dryrun("11 two workers stuck (-> A2, both panes listed)",
       [agent("wE:pV", "wE:t1", "idle", fresh), agent("wE:p1", "wE:t1", "working", stale),
        agent("wE:p2", "wE:t1", "working", sess(d, "w18.jsonl", 18 * 60 + 5))],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker"), pane("wE:p2", "wE", "worker")],
       expect=["action: send message A2 -> wE:pV",
               "[heartbeat] worker wE:p1, wE:p2 has produced no output (state is still working)."])

# 7 Multiple workers: one stuck, one fresh.
dryrun("7 multiple workers: one stuck, one fresh",
       [agent("wE:pV", "wE:t1", "idle", fresh), agent("wE:p1", "wE:t1", "working", stale),
        agent("wE:p2", "wE:t1", "working", fresh)],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker"), pane("wE:p2", "wE", "worker")],
       expect=["it is really working (return)", "note: another pane (wE:p1) has been stuck", "action: none"])

# 8 Reviewer has no session file path -> WARN + no action.
dryrun("8 reviewer agent_session is not a path (-> WARN + no action)",
       [agent("wE:pV", "wE:t1", "working"), agent("wE:p1", "wE:t1", "idle", fresh)],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")],
       expect=["WARN", "has no session file path", "reviewer: working", "action: none"])

# 9 Session file stat fails (deleted / missing path) -> skip, not stuck.
dryrun("9 session file stat fails (-> skip, not stuck)",
       [agent("wE:pV", "wE:t1", "idle", fresh),
        agent("wE:p1", "wE:t1", "working", os.path.join(d, "no-longer-exists.jsonl"))],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")],
       expect=["WARN", "could not be stat'ed", "action: none"])

# 10 Two reviewer panes in one tab -> cannot identify (WARN).
dryrun("10 two reviewer panes in one tab (-> WARN, no heartbeat)",
       [agent("wE:pV", "wE:t1", "idle", fresh), agent("wE:pW", "wE:t1", "idle", fresh),
        agent("wE:p1", "wE:t1", "idle", fresh)],
       [pane("wE:pV", "wE", "reviewer"), pane("wE:pW", "wE", "reviewer"),
        pane("wE:p1", "wE", "worker")],
       expect=["WARN", "cannot identify a pair"],
       expect_absent=["action:"])

print("\n===== C. stage 3: real send / real interrupt (fake herdr) + daemon + rotation + lock =====")


def fake_dir(agents, panes, sessions=("selftest",), tabs=()):
    d = tempfile.mkdtemp(prefix="hb-selfC-")
    with open(os.path.join(d, "scen.json"), "w") as f:
        json.dump({"agents": agents, "panes": panes, "sessions": list(sessions),
                   "tabs": list(tabs)}, f)
    return d


def fake_env(d):
    return {"HB_FAKE_SCENARIO": os.path.join(d, "scen.json"),
            "HB_FAKE_LOG": os.path.join(d, "mutations.log"),
            "HB_DIR": d, "HERDR_SESSION": "selftest"}


def mutations(d):
    p = os.path.join(d, "mutations.log")
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []


TXT_A1 = ("[heartbeat] Your command produced no output, so I interrupted it "
          "(you may see \"Command aborted\").\n"
          '- Keep going. If a long task was interrupted by mistake, call '
          'hb_block(action=block, reason="long task") and unblock when done.')
TXT_A2 = ("[heartbeat] worker wE:p1 has produced no output (state is still working).\n"
          '- Long task (e2e etc.)? Block on behalf of the pair: '
          'hb_block(action=block, reason="…"), then unblock when done.\n'
          '- Really stuck? Go to that pane and handle it (send-keys esc / re-dispatch).')
# Section C makes its own 23-minute file: the one from section B may be a minute older by now.
cstale = sess(d, "cstale.jsonl", 23 * 60 + 5)
STUCK_PAIR = ([agent("wE:pV", "wE:t1", "idle", fresh), agent("wE:p1", "wE:t1", "working", cstale)],
              [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")])
STUCK_TABS = ({"tab_id": "wE:t1", "label": "in-progress", "number": 1},)


def printed_text(out):
    """herdr-watchdog prints plan['text'] verbatim: take the block after '--- message X ---'
    up to the log / next pair."""
    lines = out.splitlines()
    i = next((i for i, l in enumerate(lines) if l.strip().startswith("--- message")), None)
    if i is None:
        return None
    block = []
    for l in lines[i + 1:]:
        if l == "" or l.startswith(("===", "[dry-run]")) or l[:1].isdigit():
            break
        block.append(l)
    return "\n".join(block)

# C1 Worker stuck, reviewer idle -> send only, no interrupt.
d = fake_dir(*STUCK_PAIR, tabs=STUCK_TABS)
p = run(["run", "--herdr-bin", FAKE], fake_env(d))
print("\n--- C1 really send A (fake herdr) ---\n$ herdr-watchdog run --herdr-bin test/fake-herdr\n%s" % p.stdout.rstrip())
m = mutations(d)
check("C1 sent only a prompt (no send-keys)",
      m == [["agent", "prompt", "wE:pV", TXT_A2]], json.dumps(m, ensure_ascii=False))
check("C1 log contains SEND message A2", "SEND  message A2 -> wE:pV" in p.stdout, p.stdout)
check("C1 fake herdr received exactly the printed text",
      printed_text(p.stdout) == TXT_A2,
      "printed=%r received=%r" % (printed_text(p.stdout), m[-1][-1] if m else None))

# C2 Reviewer stuck -> esc first, then A1.
d = fake_dir([agent("wE:pV", "wE:t1", "working", cstale), agent("wE:p1", "wE:t1", "idle", fresh)],
             [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")])
p = run(["run", "--herdr-bin", FAKE], fake_env(d))
print("\n--- C2 really interrupt + send (fake herdr) ---\n$ herdr-watchdog run --herdr-bin test/fake-herdr\n%s" % p.stdout.rstrip())
m = mutations(d)
check("C2 esc first, prompt second",
      m == [["agent", "send-keys", "wE:pV", "esc"], ["agent", "prompt", "wE:pV", TXT_A1]],
      json.dumps(m, ensure_ascii=False))
check("C2 log contains ESC + SEND",
      "ESC   interrupted wE:pV" in p.stdout and "SEND  message A1" in p.stdout, p.stdout)
check("C2 fake herdr received exactly the printed text (A1)",
      printed_text(p.stdout) == TXT_A1,
      "printed=%r received=%r" % (printed_text(p.stdout), m[-1][-1] if m else None))

# C3 --dry-run still does nothing.
d = fake_dir(*STUCK_PAIR, tabs=STUCK_TABS)
p = run(["run", "--dry-run", "--herdr-bin", FAKE], fake_env(d))
check("C3 --dry-run made no write calls", mutations(d) == [], json.dumps(mutations(d)))
check("C3 --dry-run did not write a log file", not os.path.exists(os.path.join(d, "watchdog.log")))

# C4 --tab only judges that tab.
d = fake_dir([agent("wE:pV", "wE:t1", "idle", fresh), agent("wE:p1", "wE:t1", "idle", fresh)],
             [pane("wE:pV", "wE", "reviewer"), pane("wE:p1", "wE", "worker")])
p = run(["run", "--dry-run", "--tab", "wE:other", "--herdr-bin", FAKE], fake_env(d))
check("C4 --tab mismatch -> no pair judged",
      "no identifiable pairs (--tab wE:other)" in p.stdout, p.stdout)
p = run(["run", "--dry-run", "--tab", "wE:t1", "--herdr-bin", FAKE], fake_env(d))
check("C4 --tab match -> judged normally", "=== selftest/wE:t1" in p.stdout, p.stdout)

# C5 Log rotation (small HB_LOG_MAX).
d = fake_dir(*STUCK_PAIR, tabs=STUCK_TABS)
with open(os.path.join(d, "watchdog.log"), "w") as f:
    f.write("x" * 300)
env = fake_env(d)
env["HB_LOG_MAX"] = "200"
run(["run", "--herdr-bin", FAKE], env)
check("C5 rotates to .1 when over the limit", os.path.exists(os.path.join(d, "watchdog.log.1")),
      str(os.listdir(d)))
check("C5 rotated log is short", os.path.getsize(os.path.join(d, "watchdog.log")) < 300)


def daemon_bg(d, pause=False, seconds=3.0):
    if pause:
        open(os.path.join(d, "PAUSE"), "w").close()
    p = subprocess.Popen([sys.executable, HB, "daemon", "--interval", "0.5",
                          "--herdr-bin", FAKE],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         env=fake_env(d))
    time.sleep(seconds)
    return p


# C6/C7 daemon: PAUSE pauses + a second instance yields.
d = fake_dir(*STUCK_PAIR, tabs=STUCK_TABS)
p = daemon_bg(d, pause=True)
# Second instance: with a timeout - if the lock is broken it runs forever (the test must not hang).
try:
    second = subprocess.run([sys.executable, HB, "daemon", "--herdr-bin", FAKE],
                            capture_output=True, text=True, env=fake_env(d), timeout=4)
    second_rc, second_out = second.returncode, second.stdout
except subprocess.TimeoutExpired as e:
    second_rc, second_out = None, (e.stdout or "") if isinstance(e.stdout, str) else (e.stdout or b"").decode()
p.terminate()
out, _ = p.communicate()
print("\n--- C6 daemon + PAUSE (SIGTERM after 3s) ---\n$ herdr-watchdog daemon --interval 0.5 --herdr-bin test/fake-herdr\n%s"
      % out.rstrip())
check("C6 PAUSE present -> log says paused", "PAUSE present -> paused" in out, out)
check("C6 no action while paused", mutations(d) == [], json.dumps(mutations(d)))
check("C6 log written to HB_DIR/watchdog.log",
      "PAUSE present" in open(os.path.join(d, "watchdog.log")).read())
check("C7 second instance yields (no double send)",
      second_rc == 0 and "an instance is already running" in second_out,
      "rc=%s %s" % (second_rc, second_out))

# C8 No PAUSE -> the daemon acts (through fake herdr).
d = fake_dir(*STUCK_PAIR, tabs=STUCK_TABS)
p = daemon_bg(d, seconds=2.5)
p.terminate()
out, _ = p.communicate()
print("\n--- C8 daemon actually acts (fake herdr) ---\n%s" % out.rstrip())
check("C8 daemon really sent message A2",
      any(x[:2] == ["agent", "prompt"] for x in mutations(d)),
      json.dumps(mutations(d), ensure_ascii=False))
check("C8 log writes SEND + start lines", "SEND  message A2" in out and "start pid=" in out, out)

# C8b Snapshot written every pass (food for the top view).
snap = json.load(open(os.path.join(d, "last-pass.json")))
pr0 = (snap.get("pairs") or [{}])[0]
check("C8b a real pass writes the snapshot (pid/ts/interval/sessions)",
      bool(snap.get("pid")) and snap.get("ts") and snap.get("interval") == 0.5
      and snap.get("sessions") == ["selftest"] and snap.get("paused") is False,
      json.dumps({k: v for k, v in snap.items() if k != "pairs"}, ensure_ascii=False))
check("C8b each pair carries tab name / flag / action / pane facts / judge lines",
      pr0.get("tab") == "wE:t1" and pr0.get("tab_name") == "in-progress"
      and pr0.get("reviewer") == "wE:pV"
      and pr0.get("workers") == ["wE:p1"] and pr0.get("flag") is False
      and pr0.get("action") == "prompt" and pr0.get("why") == "worker-stuck"
      and [p.get("id") for p in pr0.get("panes") or []] == ["wE:pV", "wE:p1"]
      and pr0["panes"][0]["status"] == "idle" and pr0["panes"][1]["age"] > 1200
      and any("worker wE:p1 stuck" in l for l in pr0.get("lines") or []),
      json.dumps(pr0, ensure_ascii=False))
check("C8b snapshot records how long the last pass took (took)", snap.get("took") is not None and snap["took"] >= 0,
      json.dumps(snap.get("took")))

# C9 --all-sessions really scans every running session.
d = fake_dir(*STUCK_PAIR, sessions=("selftest", "other"))
p = run(["run", "--dry-run", "--all-sessions", "--herdr-bin", FAKE], fake_env(d))
check("C9 both sessions scanned",
      "=== selftest/wE:t1" in p.stdout and "=== other/wE:t1" in p.stdout, p.stdout)

print("\n===== D. message content: no time / names kept / no dead code =====")
spec = importlib.util.spec_from_loader("hbblock", importlib.machinery.SourceFileLoader("hbblock", HB))
hb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hb)

TIME_WORDS = re.compile(r"\b(minute|hour|day|second)s?\b", re.I)


def no_time(t):
    return not TIME_WORDS.search(t)


A1, A2, B = hb.TEXT_A1, hb.TEXT_A2.format(who="wE:p1"), hb.TEXT_B
check("D1 none of the three messages contains a time word",
      no_time(A1) and no_time(A2) and no_time(B),
      " | ".join(t.splitlines()[0] for t in (A1, A2, B)))
check("D2 this assertion has teeth (it fails on a real time word)", not no_time("last output 23 minutes ago"))
check("D3 all three start with [heartbeat] ", all(t.startswith("[heartbeat] ") for t in (A1, A2, B)))
check("D4 old wording is gone",
      not any(w in (A1 + A2 + B) for w in ("not a human asking", "no need to reply", "please self-check")))
check("D5 B keeps the reminder without a hardcoded duration",
      "I will ask again unless you block." in B and no_time(B), B)
check("D6 A2 interpolates names: one and several",
      "worker wE:p1 has produced no output" in hb.TEXT_A2.format(who="wE:p1")
      and "worker wE:p1, wE:p2 has produced no output" in hb.TEXT_A2.format(who="wE:p1, wE:p2"))
check("D7 no dead code (fmt_ago / fmt_ago_sp / text_a1 / text_a2 / text_b are gone)",
      not any(hasattr(hb, n) for n in ("fmt_ago", "fmt_ago_sp", "text_a1", "text_a2", "text_b")))
check("D8 fmt_age is still used by judging (logs still carry age)", hasattr(hb, "fmt_age") and hb.fmt_age(15 * 60) == "15m")

print("\n===== E. top view (stub screen, no tty needed) =====")


class StubScreen:
    """Pretend to be a curses screen: record drawn segments (with y/x/attr, to verify columns and signal colors)."""

    def __init__(self, h, w):
        self.h, self.w, self.rows = h, w, []

    def getmaxyx(self):
        return self.h, self.w

    def erase(self):
        self.rows = []

    def addnstr(self, y, x, text, n, attr=0):
        self.rows.append((y, x, text, attr))


def lines_of(scr):
    """Assemble segments drawn at the same row (later draws overwrite earlier ones, like curses)."""
    out = {}
    for y, x, text, _a in sorted(scr.rows, key=lambda r: (r[0], r[1])):
        line = out.get(y) or ""
        if len(line) < x:
            line += " " * (x - len(line))
        out[y] = line[:x] + text
    return out


SIG = 99          # test-only: sentinel attr values
TEST_ATTRS = {"signal": SIG, "call": 98, "dim": 1, "head": 97, "beat": 96}


def render(h=18, w=100, attrs=TEST_ATTRS):
    scr = StubScreen(h, w)
    animating, left = hb.top_draw(scr, dict(attrs))
    rows = lines_of(scr)
    return rows, " | ".join(t for _, t in rows.items()), animating, left


d = fake_dir(*STUCK_PAIR, tabs=STUCK_TABS)
run(["run", "--herdr-bin", FAKE], fake_env(d))          # real pass -> snapshot
hb.HB_DIR = d                                            # the view reads this directory
before = mutations(d)
snap_p = os.path.join(hb.HB_DIR, "last-pass.json")


def snapshot_at(age, took=0, **patch):
    """Move the pass to `age` seconds ago, to pose different frames."""
    snap = json.load(open(snap_p))
    snap["ts"], snap["took"] = time.time() - age - took, took
    snap.update(patch)
    json.dump(snap, open(snap_p, "w"))
    return snap


def frame(attrs=TEST_ATTRS, h=18, w=100):
    scr = StubScreen(h, w)
    animating, left = hb.top_draw(scr, dict(attrs))
    return scr, lines_of(scr), animating, left


snapshot_at(6)                                       # static: the pass is long over, animation done
rows, all_text, animating, left = render()


def lit(scr):
    """Which segments are drawn in the signal color (only while animating)."""
    return [t for _y, _x, t, a in scr.rows if a == SIG]


scr0 = StubScreen(18, 100)
hb.top_draw(scr0, dict(TEST_ATTRS))
print("-- 18x100 (static: the pass just ended, signal landed) --")
print("\n".join("%2d| %s" % (y, t) for y, t in sorted(rows.items())))
check("E1 header: heartbeat + daemon status (pid gone -> say so) + interval + q quit",
      (rows[0].startswith(" ♥") or rows[0].startswith(" ♡"))
      and "watchdog v3" in rows[0] and "daemon gone" in rows[0] and ("%gs/pass" % hb.INTERVAL) in rows[0]
      and "q quit" in rows[0], rows.get(0))
check("E2 second row: second hand + progress bar + seconds to next pass (interval follows INTERVAL)",
      "6s" in rows[1] and "█" in rows[1] and ("next in %ds" % (hb.INTERVAL - 6)) in rows[1],
      rows.get(1))
check("E3 trunk present, one branch from trunk to leaf",
      rows[1].lstrip().startswith("┃") and "┗━━━━━ 📣" in rows[2], repr(rows.get(2)))
check("E4 leaf row: tab name + hb value + which pane was called",
      "📣 in-progress (wE:t1)" in rows[2] and "hb:false" in rows[2]
      and "A2 → wE:pV" in rows[2], repr(rows.get(2)))
check("E5 leaf columns aligned (every pane name starts at the same column)",
      {x for y, x, t, a in scr0.rows if t.startswith(("📣", "😴", "👂"))} == {hb.LEAF_X},
      str([(y, x, t[:4]) for y, x, t, a in scr0.rows if t[:1] in "📣😴👂"]))
check("E6 pane facts row (id + role + status + age)",
      any("wE:pV reviewer idle" in t and "wE:p1 worker working" in t for t in rows.values()), all_text)
check("E7 does not copy judge lines: codes + pane facts say it all",
      not hasattr(hb, "top_why") and "judge:" not in all_text, all_text)
check("E8 no log in the view (tail_lines is gone)",
      not hasattr(hb, "tail_lines") and "watchdog.log" not in all_text, all_text)
check("E9 the view makes no herdr calls (reads the snapshot only)", mutations(d) == before, json.dumps(mutations(d)))

# Column alignment: three tab names of different lengths; (tab) / hb: / action must align.
keep = open(snap_p).read()
base = json.loads(keep)["pairs"][0]
json.dump({"at": "x", "ts": time.time() - 6, "took": 0, "pid": os.getpid(), "interval": hb.INTERVAL,
           "paused": False, "sessions": ["selftest"],
           "pairs": [dict(base, tab="wE:t1", tab_name="in-progress", flag=True, action=None),
                     dict(base, tab="wE:tH", tab_name="tmp", flag=True, action=None),
                     dict(base, tab="wE:tJ", tab_name="refactor", flag=True, action=None)]},
          open(snap_p, "w"))
rows, all_text, animating, left = render()
print("-- three-column alignment --\n" + "\n".join("%2d|%s" % (y, t) for y, t in sorted(rows.items())))
leaves = [t for t in rows.values() if "hb:" in t]
cols = {(t.index("("), t.index("hb:"), t.index("skip")) for t in leaves}
check("E9b three-column alignment: different tab names, (tab) / hb: / action all start at the same column",
      len(leaves) == 3 and len(cols) == 1, str(sorted(cols)) + " :: " + str(leaves))
open(snap_p, "w").write(keep)


# ---- Signal animation: pose the pass at "just happened" to see the signal run ----
snap_p = os.path.join(hb.HB_DIR, "last-pass.json")
snap0 = json.load(open(snap_p))
# Two signals at once: each row must show its own tab name (this bug really happened).
two = json.load(open(snap_p))
two["pairs"] = [dict(two["pairs"][0]),
                dict(two["pairs"][0], tab="wE:tJ", tab_name="refactor",
                     target="wE:pJ", why="reviewer-stuck", action="interrupt")]
json.dump(two, open(snap_p, "w"))
scr, paint, animating, left = frame()
print("-- two signals at once (0.9s after call) --\n" + "\n".join("%2d| %s" % (y, t) for y, t in sorted(paint.items())))
leaves = [t for t in paint.values() if "📣" in t]
check("E13b two signals at once: each row keeps its own tab / target pane",
      len(leaves) == 2
      and sum("in-progress" in t and "wE:pV" in t for t in leaves) == 1
      and sum("refactor" in t and "wE:pJ" in t for t in leaves) == 1,
      str(leaves))


snapshot_at(0.25)                                   # signal still on the trunk
scr, paint, animating, left = frame()
print("-- 0.25s after call: signal on the trunk --\n" + "\n".join("%2d| %s" % (y, t) for y, t in sorted(paint.items())))
check("E10 right after a call: animating (returns True)", animating is True, str(animating))
check("E11 a signal dot ◆ on the trunk (not branched yet)", any(t == "◆" for t in lit(scr)), str(lit(scr)))

snapshot_at(0.62)                                   # on the branch, not at the leaf
scr, paint, animating, left = frame()
print("-- 0.62s after call: signal on the branch --\n" + "\n".join("%2d| %s" % (y, t) for y, t in sorted(paint.items())))
check("E12 trunk lit to this row + branch partly lit + ● in flight",
      any(t == "┗" for t in lit(scr)) and any(t == "●" for t in lit(scr)) and len(lit(scr)) >= 3,
      str(lit(scr)))

snapshot_at(1.0)                                    # reached the pane, flash
scr, paint, animating, left = frame()
check("E13 leaf flashes after receiving (✦ pulse, signal color)",
      any("✦" in t for _y, _x, t, _a in scr.rows) and animating is True,
      str([t for _y, _x, t, a in scr.rows if a == SIG]))

snapshot_at(6)                                      # past the animation window
scr, paint, animating, left = frame()
check("E14 past the window: not animating (but 📣 stays, so the call is still visible)",
      animating is False and not lit(scr)
      and any("📣" in t for t in paint.values()), str(lit(scr)))

with open(os.path.join(d, "selftest__wE:t1.json"), "w") as f:
    json.dump({"session": "selftest", "tab": "wE:t1", "reviewer_pane": "wE:pV", "current": True,
               "current_since": "2026-10-16T13:01:41", "current_reason": "long task", "history": []}, f)
run(["run", "--herdr-bin", FAKE], fake_env(d))
rows, all_text, animating, left = render()
check("E15 hb:true: drawn as 😴 + hb:true + block start time (hour:minute) + skip",
      any("😴 in-progress" in t and "hb:true 13:01" in t and "skip" in t
          for t in rows.values()), all_text)

# Two pairs + a short screen -> the second does not fit and must say so.
two = json.load(open(snap_p))
two["pairs"] = two["pairs"] + [dict(two["pairs"][0], tab="wE:t2", tab_name="master", flag=True)]
json.dump(two, open(snap_p, "w"))
rows, all_text, animating, left = render(h=4, w=60)
print("-- 4x60 (two pairs) --\n" + "\n".join("%2d| %s" % (y, t) for y, t in sorted(rows.items())))
check("E16 very short screen (4 rows, two pairs): no crash, says how many pairs were not drawn",
      any("more)" in t for t in rows.values()), all_text)

# Daemon dead for a long time -> header says so.
snap = json.load(open(snap_p))
snap["ts"], snap["pid"], snap["took"] = time.time() - 7200, 999999, 2
json.dump(snap, open(snap_p, "w"))
rows, all_text, animating, left = render()
check("E17 two-hour-old snapshot: says daemon gone + second row says last pass 2.0h ago",
      "daemon gone" in rows[0] and "2.0h" in rows[1], rows.get(0) + " | " + rows.get(1))

hb.HB_DIR = tempfile.mkdtemp(prefix="hb-selfE-")
rows, all_text, animating, left = render()
check("E18 no snapshot: no crash, says no snapshot",
      "no snapshot" in rows[0] and "no snapshot" in all_text, all_text)
hb.HB_DIR = os.path.dirname(HB)   # restore

# where(): herdr omits HERDR_SESSION for the default session; a single running
# session is unambiguous, two are not.
import types
old_env = {k: os.environ.get(k) for k in ("HERDR_SESSION", "HERDR_TAB_ID")}
old_rs = hb.running_sessions
os.environ.pop("HERDR_SESSION", None)
os.environ["HERDR_TAB_ID"] = "wE:tX"
a = types.SimpleNamespace(session=None, tab=None)
hb.running_sessions = lambda _bin: ["default"]
s, t, err = hb.where(a)
check("F1 one running session: where() uses it when HERDR_SESSION is missing",
      (s, t, err) == ("default", "wE:tX", None), "%r %r %r" % (s, t, err))
hb.running_sessions = lambda _bin: ["a", "b"]
s, t, err = hb.where(a)
check("F2 two running sessions: where() still asks for --session", err is not None, "%r" % (err,))
hb.running_sessions = old_rs
for k, v in old_env.items():
    if v is None:
        os.environ.pop(k, None)
    else:
        os.environ[k] = v

snap = json.load(open(snap_p))
snap["pid"] = os.getpid()
json.dump(snap, open(snap_p, "w"))
rows, all_text, animating, left = render()
check("E19 live pid: header shows pid, not 'daemon gone'",
      ("pid %d" % os.getpid()) in rows[0], rows.get(0))

print("\n================ %s ================" % ("all passed" if not fails else "failed: %s" % fails))
sys.exit(1 if fails else 0)
